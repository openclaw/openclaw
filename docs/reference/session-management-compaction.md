---
summary: "Deep dive: session store + transcripts, lifecycle, and (auto)compaction internals"
read_when:
  - You need to debug session ids, transcript events, or session row fields
  - You are changing auto-compaction behavior or adding "pre-compaction" housekeeping
  - You want to implement memory flushes or silent system turns
title: "Session management deep dive"
---

A single **Gateway process** owns session state end-to-end. UIs (macOS app, web Control UI, TUI) query the Gateway for session lists and token counts. In remote mode, the per-agent SQLite database lives on the remote host, so checking your local Mac's state will not reflect what the Gateway is using.

Overview docs first: [Session management](/concepts/session), [Compaction](/concepts/compaction), [Memory overview](/concepts/memory), [Memory search](/concepts/memory-search), [Session pruning](/concepts/session-pruning), [Transcript hygiene](/reference/transcript-hygiene), full config reference at [Agent config](/gateway/config-agents).

This page is an index. The deep dive is documented on five pages, one per
reader job. Open the page that matches your task and stay there.

| Page                                                                                        | Read it when                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Session state on disk](/reference/session-management-compaction/store)                     | The two persistence layers and the per-agent paths on the Gateway host.                          |
| [Store maintenance and retention](/reference/session-management-compaction/maintenance)     | `session.maintenance` keys, disk-budget cleanup, cron retention, and the SQLite downgrade path.  |
| [Session keys, ids, and transcript events](/reference/session-management-compaction/schema) | `sessionKey` patterns, `sessionId` lifecycle, `SessionEntry` fields, and transcript entry types. |
| [Compaction behavior and settings](/reference/session-management-compaction/compaction)     | What compaction does, when it runs, its settings and providers, and where it surfaces.           |
| [Silent turns and the memory flush](/reference/session-management-compaction/housekeeping)  | The `NO_REPLY` contract and `agents.defaults.compaction.memoryFlush`.                            |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as
`/reference/session-management-compaction#when-auto-compaction-happens` still resolves. Each entry points at the
page that now holds the content.

- <a id="two-persistence-layers" />[Two persistence layers](/reference/session-management-compaction/store#two-persistence-layers)
- <a id="on-disk-locations" />[On-disk locations](/reference/session-management-compaction/store#on-disk-locations)
- <a id="store-maintenance-and-disk-controls" />[Store maintenance and disk controls](/reference/session-management-compaction/maintenance#store-maintenance-and-disk-controls)
- <a id="downgrading-after-the-sqlite-flip" />[Downgrading After The SQLite Flip](/reference/session-management-compaction/maintenance#downgrading-after-the-sqlite-flip)
- <a id="cron-sessions-and-run-logs" />[Cron sessions and run logs](/reference/session-management-compaction/maintenance#cron-sessions-and-run-logs)
- <a id="session-keys-(sessionkey)" /><a id="session-keys-sessionkey" />[Session keys (`sessionKey`)](/reference/session-management-compaction/schema#session-keys-sessionkey)
- <a id="session-ids-(sessionid)" /><a id="session-ids-sessionid" />[Session ids (`sessionId`)](/reference/session-management-compaction/schema#session-ids-sessionid)
- <a id="session-store-schema" />[Session store schema](/reference/session-management-compaction/schema#session-store-schema)
- <a id="transcript-event-structure" />[Transcript event structure](/reference/session-management-compaction/schema#transcript-event-structure)
- <a id="context-windows-vs-tracked-tokens" />[Context windows vs tracked tokens](/reference/session-management-compaction/compaction#context-windows-vs-tracked-tokens)
- <a id="compaction%3A-what-it-is" /><a id="compaction-what-it-is" />[Compaction: what it is](/reference/session-management-compaction/compaction#compaction-what-it-is)
- <a id="chunk-boundaries-and-tool-pairing" />[Chunk boundaries and tool pairing](/reference/session-management-compaction/compaction#chunk-boundaries-and-tool-pairing)
- <a id="when-auto-compaction-happens" />[When auto-compaction happens](/reference/session-management-compaction/compaction#when-auto-compaction-happens)
- <a id="compaction-settings" />[Compaction settings](/reference/session-management-compaction/compaction#compaction-settings)
- <a id="pluggable-compaction-providers" />[Pluggable compaction providers](/reference/session-management-compaction/compaction#pluggable-compaction-providers)
- <a id="user-visible-surfaces" />[User-visible surfaces](/reference/session-management-compaction/compaction#user-visible-surfaces)
- <a id="silent-housekeeping-(no_reply)" /><a id="silent-housekeeping-no_reply" />[Silent housekeeping (`NO_REPLY`)](/reference/session-management-compaction/housekeeping#silent-housekeeping-no_reply)
- <a id="pre-compaction-memory-flush" />[Pre-compaction memory flush](/reference/session-management-compaction/housekeeping#pre-compaction-memory-flush)

## Troubleshooting checklist

- **Session key wrong?** Start with [/concepts/session](/concepts/session) and confirm the `sessionKey` in `/status`.
- **Store vs transcript mismatch?** Confirm the Gateway host and the store path from `openclaw status`.
- **Compaction spam?** Check the model's context window (too small forces frequent compaction) and tool-result bloat (tune session pruning).
- **Every prompt seems to overflow on a small local model?** Confirm the provider reports the correct model context window. OpenClaw can cap the effective reserve only when that window is known.
- **Silent turns leaking?** Confirm the reply starts with the exact silent token `NO_REPLY` (case-insensitive) and you are on a build that includes the streaming-suppression fix (`2026.1.10`+).

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
- [Context engine](/concepts/context-engine)
- [Agent config reference](/gateway/config-agents)
