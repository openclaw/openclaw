---
summary: "How Knowledge works as the selected memory provider: shared reads, prompt, automatic recall, and the pre-compaction flush"
read_when:
  - You selected Knowledge for plugins.slots.memory and want to know what changes
  - You are debugging recall, automatic recall, or memory flush with Knowledge
  - You need to know what Knowledge does not replace from memory-core
title: "Knowledge as memory provider"
sidebarTitle: "Memory provider"
---

What Knowledge does when it owns `plugins.slots.memory`. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

## Ownership and activation

Knowledge declares `kind: "memory"`. Select it with
`plugins.slots.memory: "knowledge"`; see
[Enable Knowledge](/plugins/knowledge#enable-knowledge). An unselected memory
plugin is disabled by the slot gate, so Knowledge has no companion mode beside
another memory provider.

Knowledge registers its native tools, read-only UI, and memory provider runtime
together. They share one storage runtime per store and one serialized operation
lane. Selecting Knowledge does not migrate or delete `memory-core` data.
Switching back leaves the vault intact.

Every provider call resolves the requested agent's effective store through the
same resolver as the native tools. An `owner-private` audience maps to the
store's private partition; a `conversation` audience maps to that session's
partition. Missing, foreign, and sandboxed callers are denied.

## Shared memory reads

The provider exposes the host's shared search and read contract over Knowledge
records:

- Search uses current, eligible, scope-filtered records with keyword BM25, not
  embeddings. Scores are query-local and `minScore` is enforced. The provider
  declares only the `memory` source, so requests for `sessions` are rejected
  before they reach Knowledge. It does not filter by project during search.
- Search hits include title, assertion origin, and attribution. Reads add up to
  20 retained-evidence locators. The shared API is a projection; use the native
  tools for full evidence, metadata, and relationships.
- Reads return active eligible pages, claims, and relationships. Historical,
  withdrawn, invalid, and fixture records stay with the native exact and history
  tools. Reads use 1-based lines over the rendered title, attribution, and body:
  100 lines by default, at most 200 per request.
- References carry the provider, record ID, revision, content hash, and store
  identity. They grant no access. A changed revision rejects the read; a reference
  or cursor from another store is rejected.
- Search cursors bind the query, filters, scope, store, and index snapshot. A
  changed snapshot rejects the continuation. Failed indexing is an error, never an
  empty success.
- Health reports scoped vault and ontology validation. Host status handles opened
  with `purpose: "status"` (doctor, CLI status) receive readiness only: no record
  counts, scope, IDs, or paths.

The capability declares `knowledge_grep`, `knowledge_lookup`, and
`knowledge_record` as recall tools. [Active Memory](/concepts/active-memory)
uses them for deep recall and passes the parent turn's audience to the child
run.

## Memory prompt

The selected-provider prompt describes Knowledge as the user's world knowledge:
entities (people, companies, projects, repositories, concepts and anything else
the active ontology can represent) and what is known about them. It asks the
agent to:

- search once for each entity a task names, not just the first, or earlier work
  it refers to, before planning, and follow the knowledge-recall skill for deeper questions;
- save decisions, preferences, corrections, commitments, project-state changes,
  and explicit remember requests with `knowledge_remember` before the final reply,
  without being prompted, worded no more broadly than the supporting excerpt,
  in one call with a fresh `requestId` and the claims in `items`;
- keep a page for work that spans turns or that the user will return to, and
  for each person, organization or project the user treats as significant:
  reuse the page recall found or create it right away through
  knowledge-entities, keep its
  current state accurate through knowledge-capture, and record the agent's own
  findings there as analysis rather than in `knowledge_remember`, which never
  stores agent inference;
- record replacements and contradictions with knowledge-correct instead of
  parallel claims;
- route documents, transcripts and entity work to the bundled skills when those
  skills and their tools are available;
- cite saved records with links to the Knowledge page in the Control UI.

When writes are disabled or the save tools are missing, the prompt omits save
guidance. The prompt excludes secrets and treats retrieved content as evidence,
not instructions.

When the host supplies a repository project key, the prompt names it as the
alias of the repository's project page and asks the agent to pass it as the
`knowledge_remember` subject for claims about that repository. Knowledge never
applies the key as a default subject; the agent chooses. The key reaches only the
prompt, not tool calls.

Remembering is best effort. Saving a preference neither configures the assistant
nor guarantees that the preference loads in future turns.

## Knowledge index

Owner-private sessions also receive a short, generated `## Knowledge Index` at
the end of the system prompt, so the agent knows what its vault holds without
searching first. Knowledge adds it through `before_prompt_build`
`appendSystemContext`; no setting controls it.

- It lists labels only: page type, title and one exact alias that
  `knowledge_lookup` resolves. It also lists recent claims (last 14 days) that
  are not filed under any page, ranked decisions, commitments and preferences
  first. Claims filed under a page appear as that page's new-claim count. The
  three busiest pages also list their three newest decisions and commitments
  beneath them, each claim shown once. Bodies, evidence, `source` and
  `artifact` pages and relationships are never listed.
- Pages come in two groups: recently active (the page, or a claim or
  relationship about it, recorded in the last 14 days) and most connected. A
  footer counts unlisted pages by type. The whole index is at most 4,000
  characters. When every page fits, the remaining space lists more unfiled
  claims.
- Labels are one line and clipped. A title that reads like an instruction or
  contains markup is shown as its record ID only. The index says its entries are
  stored labels, not instructions.
- The index selects records recorded at or before the session's first retained
  message, so it stays byte-identical across turns and refreshes after a new
  session or compaction. Records saved during the session appear after the
  next refresh.
- Conversation audiences, sandboxed sessions, sessions without host memory
  authority and agents without a provisioned store get no index. Read failures
  omit the index and never block the turn.

The index is not owner-approved recall. It injects only labels and clipped
claim headlines, never page bodies or evidence.

## Automatic recall

Automatic prompt injection uses only summaries the owner approved with
`knowledge_recall`. Keyword search is never a trusted source for injected
context.

- `knowledge_recall` sets or clears a `recall` block on one exact active record:
  `summary` (1–500 characters, required), up to 20 `triggers`, `importance`
  (1–10), and up to 20 host `projects` keys.
- It requires writes enabled and a current owner-private audience. Conversation
  audiences, operators, and the browser cannot approve recall.
- Claims with `assertion_origin` of `source` or `agent_inference` cannot be
  approved, because external or inferred text is not owner-approved context.
- The service writes `approved_by: owner-private` and `approved_at`; callers
  cannot set them.
- Corrections do not inherit approval. Approve the replacement again.

Candidates are available only to an owner-private audience: trigger candidates
need at least one trigger, project candidates at least one project key. They sort
by descending importance, then record ID. The default limit is 48 and the
maximum is 200. Each candidate excerpt is exactly the approved summary; record
bodies and ingested text never enter it. A conversation audience receives no
candidates.

## Pre-compaction memory flush

Knowledge owns the pre-compaction flush when `writesEnabled` is `true`. With
writes disabled the provider returns no flush plan, which also prevents a
`memory-core` file flush.

- Persistence tools are `knowledge_remember` for discrete claims and
  `knowledge_save_page` for notes. `knowledge_grep`, `knowledge_lookup`,
  `knowledge_record`, and `knowledge_ontology` are read-only helpers. Only a
  successful save counts as persistence.
- The flush saves durable decisions, preferences, corrections, commitments,
  project-state changes, and facts about people or projects, with the supporting
  excerpt quoted. It excludes secrets and treats transcript content as data.
- The source turn's audience is delegated to the flush, so owner-private turns
  write to the private partition and conversation turns to their own partition.
  The flush grants no additional authority.
- During a flush, `knowledge_save_page` and `knowledge_remember` may omit
  `requestId`. Knowledge derives a stable ID from the host flush ID and the page
  title or claim texts, so an identical retry returns the original receipt.

The flush never runs for CLI-backend sessions such as `claude-cli/*`, or for
backends that compact natively. For those sessions, the prompt's "before your
final reply" save is the only capture point.

## What Knowledge does not replace

Workspace bootstrap files, reset hooks, dreaming, standing intents, `memory-core`
tools and CLI, and the file-oriented Memory UI are not provided by Knowledge.
The Knowledge page and the `knowledge_*` tools are its inspection and
change surfaces.
