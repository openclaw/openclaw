# Release retrospective

Every beta, stable, and extended-stable release ends with a retrospective in
`openclaw/tideclaw`. It is a closeout step, not optional polish: the release
is not done until the retrospective PR is open and its ledger update passes.
Write it after core publication, platform assets, and main closeout are terminal,
or when execution hands off to another operator (a frozen Part 1 snapshot).
ClawHub never delays this PR: record pending or failed ClawHub work with its
owner, exact run/attempt, evidence, and next action; append its outcome later.

## Collect while releasing

Keep a notes file in the session scratch directory from the first finding:
failure signatures with run and job ids, root causes, workarounds, time lost,
and every item the operator asks to include ("put this in the retro"). Record
each operator correction or nudge with its UTC time and exact words.

## Mine the session

The report must cover the whole release, not the last context window:

- Read the complete session transcript, including pre-compaction portions, and
  every subagent transcript (count `subagents/*.jsonl`, not `.meta.json`).
- Split the lead transcript into chronological quarters and the subagent files
  into halves; give each miner its own scratch directory. Miners return findings
  as text; the lead saves each result.
- Ask miners for: what happened with evidence (run ids, SHAs, PRs, error text),
  cost in wall-clock time, category, and an owner-mapped fix.

## Write the report

Answer the operator's standing question: everything that did not go well,
improvements, efficiency gains, bugs, misunderstandings, decisions the operator
had to nudge, and errors fixable with code or skill changes. Frame operator
errors as the skill or tooling change that would have prevented them. Omit
improvements the operator has already rejected.

Sections: outcome and identities (Release SHA, qualifying FRV, SDK
acknowledgement, publisher tag, closeout SHA), elapsed time with the largest
costs, run ledger, timeline, numbered findings (evidence, cost, improvements),
**operator nudges that should be defaults** (time, quote, default to encode,
owner), what worked, prioritized follow-up, and evidence and limits.

## Deliver to openclaw/tideclaw

- Read the target repository’s root and release-scoped AGENTS.md first.
- Path: `release/retrospectives/<version>.md`, with an archive row (newest
  first) in `release/retrospectives/README.md`.
- If the file exists (a handoff snapshot or an earlier part), append
  `## Part N` and keep every existing line byte-identical; ledger anchors pin
  physical line numbers.
- Commit the report before the ledger pass. After the ledger pass, change the
  report only with same-line edits or appends after the last anchored line.
- Check the PR state before amending; if it merged, open a follow-up PR.

## Update the issue ledger

`release/retrospectives/issue-ledger.md` is shared across releases:

1. Fetch `origin/main` right before the pass and list open retrospective PRs;
   new IDs start after the highest RRI on `main` and any range an open PR reserves.
2. Match each finding to existing entries by owner and invariant; add this
   release to their campaigns and pin source links
   (`<version>.md?plain=1#Lnnn-Lnnn`).
3. Add `RRI-NNN` entries for unmatched findings in the right category; update the
   header total, category counts, audit-snapshot pins, and the README summary.
4. Implement the edit as a rerunnable script with a `--check` mode that verifies
   every anchor's text, unique contiguous IDs, and count sums. A conflict with a
   concurrent retrospective means rebuilding on `main` and rerunning the script.

Validate in `openclaw/tideclaw` with the campaign's `--check` script and
`git diff --check`, following `release/AGENTS.md`. Keep reports and their
line-number anchors intact; do not run the old repository's skill-source
or website-rendering checks here. The PR body follows the problem, impact,
change, and evidence shape.

## Follow through

Each nudge-that-should-be-a-default and each P0/P1 follow-up becomes a skill,
tooling, or issue change on `main` (release-process changes then reach the
active release branch per the shared release boundaries). Link them from the
retrospective PR when they exist.

## Track in-flight fixes per agent

[openclaw/tideclaw#11 — Release Retro In-Flight Fix Tracker](https://github.com/openclaw/tideclaw/issues/11)
is the canonical coordination surface for agents fixing retrospective ledger
findings. Its **issue body**, organized into per-agent sections, owns live claims
and status. The ledger records durable findings and outcomes. Do not commit
claim reservations, WIP status, or heartbeat updates to either repository just
to advertise work. Keep unfinished changes local; commit the actual fix only
after its required work and validation are complete. This does not change the
report/ledger delivery process above.

1. **Read before claiming.** Read the current issue body and relevant comments,
   then locate the selected `RRI-NNN` entries in the current ledger and check
   linked fixes/PRs. Reuse an existing repair or coordinate with its owner
   instead of duplicating it. The tracker is coordination, not authority to
   implement, publish, merge, or release outside the task's authorization.
2. **Claim in your per-agent body section.** Use your agent name and a stable
   task/session identifier as the heading. Use one row per ledger item or
   explicitly grouped shared-cause repair; link entries and describe the scope.
   Read the issue body immediately before each edit, merge only your own section
   into that current body, and preserve the introduction and every other
   agent's section. Never replace the body from a stale local copy.
3. **Verify the edit and check overlap.** Reread the issue body after writing;
   confirm your update and the other sections remain intact. Reconcile a lost
   update or uncertain write against the current body before retrying. If claims
   overlap, coordinate one implementation owner and mark the other claim as
   handed off or released. A timestamp is not a lock, and an old update alone
   does not mean a claim is abandoned. This is lightweight coordination, not a
   locking protocol.
4. **Update at meaningful transitions.** Record status, UTC update time, next
   action, blockers, and branch/PR and focused proof links when available. A
   parent coordinating children names the actual worker per row; a handoff links
   the successor's body section and records who owns the next step. Keep live
   status in the issue body, not parallel comment records. When migrating a live
   comment, preserve its relevant content in your body section, verify the
   migration, then mark the old comment historical/superseded with a link to
   that section.
5. **Close the claim, not the tracker.** Keep `PR open` distinct from `done`: a
   published fix awaiting review, CI, or merge is still in flight. Record the
   verified outcome and fix/merge evidence when complete, or mark `released`
   with a reason when stopping without a fix. Use `blocked` with the missing
   prerequisite and next owner when work cannot proceed. Do not close issue
   #11 when your work finishes. Comments are optional for completed-batch
   closeout summaries, not live claims or progress. Update durable ledger
   outcomes through their normal reviewed process, not progress commits.

Merge this section into the issue body, replacing placeholders and omitting
unused fields:

```markdown
## Agent: <name> — <stable task/session identifier>

Updated: <YYYY-MM-DD HH:MM UTC>

| Ledger item(s) | Scope                             | Status  | Next action / blocker | Fix and evidence                |
| -------------- | --------------------------------- | ------- | --------------------- | ------------------------------- |
| <RRI links>    | <shared cause or specific repair> | claimed | <next step>           | <PR/proof links when available> |

Handoff: <none, or successor and body-section link>
```

Use plain statuses: `claimed`, `in progress`, `blocked`, `PR open`, `done`,
`handed off`, or `released`. Include only information safe for the target
repository; never paste credentials, private runtime details, or raw logs.
If you cannot update the issue body, report the claim as **unconfirmed**, retain
a local note, and ask an authorized coordinator to merge your section. Do not
substitute a live comment, repository commit, or invisible exclusive claim.
