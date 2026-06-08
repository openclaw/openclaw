# AgentGlob Fleet Diagnostic — Scheduled Agent Prompt

> Feed this whole file as the prompt to a scheduled agent run (cron / scheduled-task)
> on the **dev server** (`DevAgents`, `204.168.223.245`). It runs autonomously, end to
> end — do **not** ask questions. It DIAGNOSES and RECORDS only; it never restarts or
> reconfigures agents.

## Servers (single SSH key for both)

| Host    | Label   | Connect                                                                                  |
| ------- | ------- | ---------------------------------------------------------------------------------------- |
| EU prod | 1stClaw | `ssh -i ~/.ssh/hetzner-openclaw -o ConnectTimeout=15 -o BatchMode=yes root@89.167.70.46` |
| US prod | 2ndClaw | `ssh -i ~/.ssh/hetzner-openclaw -o ConnectTimeout=15 -o BatchMode=yes root@5.161.84.219` |

The diagnostic script SSHes to **both** hosts for you when run with `all` — you normally
don't need to SSH by hand. Use a manual SSH only to dig deeper into a specific finding.

## Bug list — the source of truth

- **Link:** https://github.com/cryptolir/openclaw/blob/main/scripts/ops/bug_list.md
- **Local checkout:** `/root/projects/openclaw/scripts/ops/bug_list.md`
- The file has two zones:
  - **Curated** tables (`Open` + `Resolved`) — human/agent-owned. You edit these with judgment.
  - **AUTOSCAN block** (between `<!-- AUTOSCAN:START -->` / `<!-- AUTOSCAN:END -->`) — the
    script owns it; **never hand-edit** inside the markers.

## Steps (run in order)

1. **Sync the repo**

   ```
   cd /root/projects/openclaw && git checkout main && git pull --rebase origin main
   ```

2. **Run the diagnostic protocol** (scans BOTH hosts, auto-refreshes the AUTOSCAN block).
   This is **read-only** on the hosts — it does not restart or change any agent.

   ```
   SSH_KEY=~/.ssh/hetzner-openclaw bash scripts/ops/agents_server_diagnostic.sh all
   ```

   Capture its full stdout — you'll need the A+B health table and the C+D prioritised
   issue list for the email.

3. **Reconcile the curated section** against what the scan reported:
   - A real issue the scan found that isn't represented in the curated `Open` table →
     add a new `OB-N` row with the right priority and a one-line fix recommendation.
   - A curated item the scan shows is now fixed/changed → update its **Status**; move a
     fully-resolved item to the **Resolved** table.
   - Priority legend: `P0` down/at-risk · `P1` high · `P2` medium · `P3` low/cosmetic.
   - Do **not** touch anything between the AUTOSCAN markers.

4. **Sync findings back to git** (keep the file and the repo in lockstep — always):

   ```
   git add scripts/ops/bug_list.md
   git commit -m "docs(ops): bug_list refresh $(date +%Y-%m-%d)"
   git push origin main
   ```

   If `push` is rejected for failing CI status checks, this is a **docs-only** change —
   merge is safe; use the same admin path the team uses for the known-broken `oxfmt`
   check on `main`.

5. **Email the summary** to **liran@agentglob.com** (see next section).

## Diagnosis-only — hard rule

This run records state; it does **not** fix things. Do **NOT** restart containers, change
models, or edit any agent config. If you find a `P0`/`P1` that needs hands-on action,
record it in the bug list and flag it **prominently at the top of the email** — a human
decides and executes.

## Email summary → liran@agentglob.com

Send a concise, skimmable summary:

- **Subject:** `[AgentGlob] Fleet diagnostic <YYYY-MM-DD> — P0:<n> P1:<n> P2:<n> P3:<n>`
- **Body (plain text or simple HTML):**
  1. **Headline:** any `P0`/`P1` that needs human action, up top, in one line each.
  2. **Host health:** EU + US — load, mem available, swap used, disk %.
  3. **Agents:** count up / total per host; name any not `running` or crash-looping.
  4. **Issues:** the prioritised `C+D` list from the scan (P0→P3).
  5. **Changed since last run:** what you added/updated/resolved in the bug list.
  6. **Link:** https://github.com/cryptolir/openclaw/blob/main/scripts/ops/bug_list.md

**Send command** (msmtp + Gmail is configured on the dev server; sender `onetrue2023@gmail.com`):

```
printf 'Subject: %s\nFrom: AgentGlob Diagnostics <onetrue2023@gmail.com>\nTo: liran@agentglob.com\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
  "$SUBJECT" "$BODY" | msmtp liran@agentglob.com
```

> Config lives in `~/.msmtprc` (chmod 600) on the dev server. If a send fails, check
> `~/.msmtp.log` — the most likely cause is a missing/expired Gmail **app password** in
> `~/.msmtprc`. As a safety net, also write the summary to
> `/root/projects/openclaw/scripts/ops/last-diagnostic-summary.txt` so it isn't lost.

## Failure handling

- A host unreachable over SSH is itself a **P0** — the script emits it; surface it loudly
  in the email rather than failing silently.
- If the scan returns nothing for a host, retry once before declaring it down.
