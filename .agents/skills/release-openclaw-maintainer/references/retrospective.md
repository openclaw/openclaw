# Release retrospective

Every beta, stable, and extended-stable release ends with a retrospective in
`openclaw/maintainers`. It is a closeout step, not optional polish: the release
is not done until the retrospective PR is open and its ledger update passes.
Write it after publication, platform assets, and main closeout are terminal, or
when execution hands off to another operator (a frozen Part 1 snapshot).

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

## Deliver to openclaw/maintainers

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

Validate with `python3 scripts/check-skill-sources.py`,
`node scripts/render-maintainer-docs.mjs` (restore unrelated render changes),
`node --test test/maintainer-docs.node-test.mjs`, and `git diff --check`. The PR
body follows the problem, impact, change, and evidence shape.

## Follow through

Each nudge-that-should-be-a-default and each P0/P1 follow-up becomes a skill,
tooling, or issue change on `main` (release-process changes then reach the
active release branch per the shared release boundaries). Link them from the
retrospective PR when they exist.
