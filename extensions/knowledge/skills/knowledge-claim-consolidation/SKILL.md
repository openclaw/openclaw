---
name: knowledge-claim-consolidation
description: Review and consolidate Knowledge claims over a chosen scope - the unlinked residue after relinking, the claims on one hub or over-budget page, or the claims about one subject since a date. File claims on their most specific subject page, create pages for substantial subjects, retire duplicates, supersede status snapshots and replaced claims by an existing claim, and review pages so each reads as a current explanation of its subject, leaving current pages alone. Use for claim cleanup, consolidation, page review, or the Knowledge Consolidation scribe.
---

# Claim consolidation review

Claims pile up faster than pages are curated: `knowledge_remember` saves claims
that name no page, and hubs collect snapshots, duplicates and claims about more
specific subjects. This review files claims on their pages, retires duplicated
and replaced claims, and keeps pages current.

## Rules card

These hold for the whole run; keep them after compaction.

1. **Never lose a citation or reachable evidence.** Before deleting or moving
   text, retiring a cited claim or dropping a page from a claim's `entities`,
   make sure the page still reaches every record it cites, and that each
   citation points at a current record.
2. **Read before writing.** Read a record before changing it; edit a body only
   from a complete, fresh read, and reread before each edit.
3. **Fences:** for manual claim changes and page writes, use a fresh
   `requestId` per distinct write and the observed `expectedVaultId`. For
   `knowledge_annotate`, `knowledge_withdraw` and `knowledge_supersede`, pass
   the records' revisions and hashes (a 16-character hash prefix is enough);
   omit `expectedOntologyFingerprint`. For page saves, body edits and section
   extraction, pass the latest fingerprint and the fences for existing pages.
   New pages have no prior revision or hash.
4. **Leave alone by default.** A page with a current State and sections that
   fit its type gets fixes only: broken citations, a stale fact a newer claim
   contradicts. Restructuring or splitting needs a named reason in the report.
5. **Never guess.** Leave uncertain identities, duplicates and outcomes
   untouched and report them. Unattended, never ask.
6. **Uncertain write:** read [recovery](references/recovery.md) first; never
   retry under a new request ID.

## Tasks

Read [setup](references/setup.md), then call `knowledge_status` and
`knowledge_ontology`. Read only the reference for the task at hand, and follow
its links only when you reach that step. You don't need to reread a reference
after compaction unless you are about to use it again.

- **Enumerate a scope, link claims, create missing pages:**
  [linking](references/linking.md).
- **Retire duplicates, replaced claims and snapshot series:**
  [retiring](references/retiring.md).
- **Review a page:** [page review](references/page-review.md), which sends you
  to [subject pages](references/profiles.md) and the one layout for the page's
  type.

## Scopes

Name the scope in the report and run its tasks in this order:

- **Unlinked residue** (default; scribe runs): link, then retire.
- **One page** (a hub, an over-budget page, or a body that no longer explains
  its subject): enumerate, move claims about a more specific subject, retire,
  then review the page. Move before retiring: a superseded or withdrawn claim
  can no longer be relinked.
- **One subject, optionally since a date:** enumerate, link, retire, then
  review its page if the new claims change its picture.

## Verify and report

Run `knowledge_verify` with `expectedEntities` for linked claims and
`expectedLinks` for new or edited pages ([verify](references/verify.md)), then
enumerate the scope again and handle or report new arrivals.

Report: scope; claims examined, linked, superseded (with the superseding claim)
and withdrawn (with the survivor); pages created and why; pages reviewed with
their result (no change, fixed, or restructured with its reason); dated
sections and Timeline entries retired and kept; and each claim or line you left
and why.

## Scribe runs

The **Knowledge Consolidation** scribe runs unattended; its prompt handles access
and the automation. Do not ask questions. Each step names its task:

1. **Link** the unlinked residue ([linking](references/linking.md)). If it is
   empty, report zero claims examined and go on.
2. **Retire** duplicates and replaced claims in it
   ([retiring](references/retiring.md)), then check the residue again.
3. **Retire written Timelines,** largest first
   ([retire a written Timeline](references/retire-dated.md#retire-a-written-timeline)).
   Find them with `knowledge_grep` for `Timeline` and confirm the heading.
4. **Review pages,** one at a time
   ([scribe page choice](references/page-review.md#scribe-page-choice)), whatever
   the residue's size.
5. Report. The status line counts claims examined, linked, superseded,
   withdrawn and left; Timelines retired and left; pages reviewed, changed and
   left unchanged.

These targets address a November 13, 2026 scheduled run that retired one
Timeline and reviewed one page with hundreds waiting
([#199744](https://github.com/openclaw/openclaw/pull/199744)). The run message
sets how many Timelines and pages a run takes on; without one,
retire 10 and review 5. These are targets, not limits: finish one before the
next, and stop short only when none are left. Compaction keeps what you
published, so a long run is no reason to stop. An item that still fails after
a fix attempt is recorded and skipped. Report any shortfall and why.
