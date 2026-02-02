# Ticket Reasoning Level Mappings

This table maps each prompt to the **minimum**, **recommended**, and **maximum** reasoning level that makes sense for execution.

**Legend**
- **Low**: straightforward wiring, follow explicit steps; no architectural decisions.
- **Medium**: some interpretation or mapping required; validate assumptions with sources.
- **High**: architectural or API‑design decisions; ambiguous specs; cross‑system tradeoffs.

| Ticket | Title | Minimum | Recommended | Maximum |
|---|---|---|---|---|
| 01 | Unify Gateway Client (Protocol v3 + Device Auth) | Medium | High | High |
| 02 | Event Stream Alignment (Chat + Tool Streams) | Low | Medium | Medium |
| 03 | System Settings Wiring (Config + Models + Usage) | Medium | Medium | High |
| 04 | Channels + Pairing + OAuth Wiring | Medium | High | High |
| 05 | Agents List + Detail Wiring | Low | Medium | Medium |
| 06 | Sessions + Chat + Conversations Wiring | Medium | Medium | High |
| 07 | Worktree + Filesystem Wiring | Low | Medium | Medium |
| 08 | Nodes, Devices, Exec Approvals Wiring | Medium | Medium | High |
| 09 | Workstreams/Goals/Rituals/Jobs Mapping Decision | High | High | High |
| 10 | Workstreams/Goals/Rituals/Jobs Implementation | Medium | High | High |
| 11 | Security, Audit, Debug Wiring | Medium | High | High |
| 12 | Memories API Wiring (Graph/Memory Track) | High | High | High |

## Notes
- **01** needs careful protocol + auth alignment with legacy UI.
- **04/11** involve multi‑step flows and security/credential edge cases.
- **09** is decision/spec‑only and must be high‑reasoning to avoid cascading errors.
