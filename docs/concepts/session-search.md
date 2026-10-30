---
summary: "Search past session transcripts and reopen the matching context"
title: "Session search"
read_when:
  - You need to find something discussed in an earlier session
  - You want to understand session search privacy or indexing
---

# Session search

`sessions_search` searches the user and assistant text in visible past sessions. Each result
includes a `sessionKey`, timestamp, role, and a short matching excerpt. Pass the returned
`sessionKey`, `messageId`, and `sessionId` together to `sessions_history` to reopen the matched
context, including retained history from before a session reset. Without `messageId`, history
returns the newest reset-relative tail. An explicit `messageId` that remains in that
current view, including a pre-reset row kept after reset, keeps current-view behavior
and can include later post-reset turns. An explicit `messageId` for a retained
active-path row outside the current view opens that original closed interval and does
not mix later post-reset turns.

Anchored reads use `limit` to bound the surrounding messages. Omit `offset` when using an anchor.
Large transcript windows may return fewer messages to stay within the source byte limit.
Jump-to-message reads retain the requested message, and directional history cursors continue
through adjacent large messages without skipping them or reporting a false end of history.
For SQLite transcript history, a missing or off-path message returns empty history rather than
the newest tail; a `sessionId` that does not belong to the selected session key is rejected.
These rules also apply in local embedded mode, without a running Gateway.

## Visibility and output

Search uses the same configured session visibility rules as `sessions_history`. The default
`tools.sessions.visibility: "all"` permits unsandboxed callers to search sessions across agents on
the Gateway, including other users' conversations. Cross-agent access is on by default and governed
by `tools.agentToAgent`; set `enabled: false` to block ordinary cross-agent access or use `allow` to
restrict agent pairs (requester-owned native subagent and ACP child sessions stay reachable under `tree` or `all`). Set explicit `agent`, `tree`, or `self` when callers need narrower session visibility.
Per-peer DM routing separates conversation context but does not restrict session-tool visibility.

Results outside the caller's effective visibility scope are removed before result limits are
applied. Sandboxed agents remain limited to sessions they spawned when spawned-session visibility
is enabled. Incognito sessions remain excluded; narrowing visibility from `all` blocks ordinary
cross-agent access.

Excerpts preserve transcript text, including credentials. Results are bounded by count, excerpt
length, and total response size.

Queries must contain text and cannot exceed 4,096 UTF-16 code units. A search
returns at most 25 hits. The tool trims each excerpt to 300 UTF-16 code units
plus an ellipsis when needed, within a 32 KiB result budget. Query words are
literal text; punctuation does not become database query syntax.

Each transcript search request allows up to 90 seconds, leaving dispatch and
authorization headroom around the reader's 60-second budget, including worker admission.
If it times out, retry `sessions_search` with a `sessionKey` to search one session
or more specific query keywords. A timeout does not mean that no matching
conversation exists.

## Control UI search

The command palette and Threads page send their session filters to the Gateway, which
searches the full authorized indexed history in that scope. The browser does not download
a session roster to choose which transcripts to search, and a roster page size does not
exclude older matching sessions.

Title searches treat punctuation and repeated whitespace as word separators, so
`per session communi` finds a conversation titled **Per-session communication
controls**. The command palette uses the same matching rule when grouping results
under Sessions or Messages. Identifier searches retain their literal matching.

Control UI message searches match the final word as a prefix while requiring the
preceding words in full. For example, `session communi` finds **session
communication**. The agent-facing `sessions_search` tool keeps exact-word matching.

The command palette also finds agent-created conversations assigned to a custom
sidebar group, by title or transcript, after you switch to another conversation.
Ungrouped spawned sessions and subagent runs remain excluded from the palette.
Groups do not grant access to private conversations or include incognito or
archived sessions in active search.

Search returns a bounded set of the best matches. More matches than the result limit is
normal, not a search-completeness warning; refine the query to narrow the results. Unconfirmed
search completeness and cold archived transcripts excluded from search have separate status
messages. Cold transcript history becomes searchable again when its session is opened
and the history is restored. Search does not restore archived history automatically.

## Index lifecycle

OpenClaw stores a full-text index with the transcript rows in each agent's database.
New user and assistant messages are indexed in the same transaction that persists them, so the
index never lags live conversations; tool results, reasoning blocks, and images are excluded.
Only the transcript's active branch is searchable.

Transcripts that predate the index (for example, sessions imported by `openclaw doctor`) and
sessions whose active branch was rewound are reindexed by a background reconciliation that starts
with the next search. Deleting a session removes its index entries in the same transaction.

A response with `indexing: true` means search completeness could not be confirmed, not necessarily
that indexing is running. Returned matches remain usable, but results may be incomplete;
retry shortly.

SQLite search uses its Unicode word tokenizer with diacritic removal. PostgreSQL
search uses the `simple` text configuration with `unaccent`, retaining literal
word, phrase, and prefix matching. Its native ranking is engine-local, so scores
and result order can differ from SQLite. See
[PostgreSQL search](/reference/database-engines#search-on-postgresql) for extension
requirements and supported modes.

Agent namespace prefixes are literal, including underscores in agent IDs.
The default-agent PostgreSQL RPC search uses a planner-selective prefix predicate
so selective text queries can start from the full-text index. Explicit session
selections and other search scopes can use different plans.

## Session search vs. memory search

Use `sessions_search` for exact words or phrases from raw session transcripts. Use
[`memory_search`](/concepts/memory-search) for durable memory files and semantic recall. The
[experimental session-memory corpus](/concepts/memory-search#session-memory-search) is the semantic
complement to this exact transcript search.

## Related

- [Session tools](/concepts/session-tool) — the `sessions_*` tool surface that exposes this search
