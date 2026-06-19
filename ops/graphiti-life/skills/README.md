# `life` workspace skills (life-only)

Git source-of-truth for the **`life` agent's per-agent workspace skills**.

These are deployed to the host at:

    2ndclaw:/root/.openclaw/agents/life/workspace/skills/<name>/

and load **only for the `life` agent** — they are NOT baked into the gateway image.

> ⚠️ **Do NOT move these into the repo's top-level `skills/` dir.** That dir is the
> **bundled / system** skill set (`/opt/openclaw/skills`), which every agent in the
> fleet loads by default (no `skills.allowBundled` allowlist) — i.e. system-wide.
> Per-agent workspace skills like these stay scoped to one agent.

## Deploy / update

```bash
scp -r ops/graphiti-life/skills/<name> \
  2ndclaw:/root/.openclaw/agents/life/workspace/skills/
ssh 2ndclaw 'chown -R 1000:1000 /root/.openclaw/agents/life/workspace/skills/<name>'
```

Effective on the agent's **next turn** (workspace skills are re-read per run — no
gateway restart needed). To verify: the dashboard shows it under **life's** per-agent
skills tab (`type: "workspace"`), and `find …/agents/*/workspace/skills -name <name>`
matches `life` only.

## Skills here

- **`personal-vision-exercise/`** — guided "בניית חזון אישי" exercise (Hebrew). Presents
  34 questions one at a time, saves answers to `Raw_חזון_אישי.md` in the user's private
  workspace, and after all 34 produces a TAL-language summary (via the `summaryskill`
  method) saved as `Sum_חזון_אישי.md`. Triggered by `load_skill personal-vision-exercise`
  when the user asks for "בניית חזון אישי" / "חזון אישי" / "אווטר".
