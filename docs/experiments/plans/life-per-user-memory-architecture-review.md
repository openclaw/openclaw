# Architecture Review: Per-User Memory for the `life` Agent

**Reviewed PR:** #54 (`docs/life-per-user-memory`)  
**Reviewed file:** `docs/experiments/plans/life-per-user-memory.md`  
**Review date:** 2026-06-04  
**Scope:** Architecture/design review before implementation.

## Executive verdict

The plan is directionally sound: Graphiti is a reasonable recall engine, the
existing per-user file should remain the visible artifact, and isolation must be
enforced server-side rather than by prompt instructions.

The main revision needed is to make the scoping proxy a strict capability
boundary and to prove that per-session identity can actually reach that boundary
safely. A proxy that merely defaults or rewrites `group_id` is not sufficient,
because the upstream Graphiti MCP server exposes UUID-based reads/deletes and
maintenance tools that can bypass simple group pinning.

One operational note: if `/root/.openclaw/agents/life/openclaw.json` is missing
on the US host, that is expected for a planned agent and should not block the
design. Phase 3 should say "create or update" that config, using another
agent's `mcp-bridge` shape as the template.

## Phase-by-phase verdict

| Phase | Verdict | Reason |
| --- | --- | --- |
| Phase 0 - Identity | Needs revision | `appUserId` exists in the save-user-section design path, but Telegram identity is underspecified. In DMs, `chat_id` often equals user id; in groups, `chat_id` is the group, not the human. |
| Phase 1 - Deploy Graphiti | Sound | FalkorDB is reasonable for v1. Keep the deploy small and agent-local. |
| Phase 2 - Scoping proxy | Needs revision / security-critical | The proxy must allowlist safe tools and strip or verify unsafe parameters. Simple `group_id` rewriting is not enough. |
| Phase 3 - Wire `life` | Needs revision | Missing `life/openclaw.json` is not a blocker, but the plan needs a concrete per-session identity handoff into the proxy. Static MCP config alone is not enough. |
| Phase 4 - Recall/write loop | Sound with guardrails | Read-before-answer and write-after-turn are good. Add write policy to avoid storing secrets or noisy full transcripts by default. |
| Phase 5 - User-file integration | Needs revision | Keeping user-file as visible artifact is right, but the current save-user-section path only handles app sessions with `appUserId`; Telegram needs an explicit visible-file path or a declared non-goal. |
| Phase 6 - Smoke + isolation tests | Needs revision | Add adversarial proxy-level tests, not just happy-path recall tests. |

## Specific risks and suggested fixes

### 1. Per-session `group_id` handoff is the crux

The `kycbot` pattern shows static MCP server config (`command`, `args`, `env`).
That is fine for registering a Graphiti proxy, but not enough to scope each user
session unless `mcp-bridge` starts a separate process per session or injects
session identity into each tool call.

**Fix:** Make the implementation choose and document one runtime mechanism:

- per-run MCP process with a scoped env var,
- bridge-injected session context on every tool call,
- or a proxy-authenticated signed session token that resolves `group_id`
  server-side per request.

Do not rely on a static agent-level env var for user identity.

### 2. Graphiti MCP exposes tools that are unsafe for user sessions

The upstream MCP server exposes search/add tools, but also UUID-based and
maintenance tools such as:

- `get_entity_edge(uuid)`
- `delete_entity_edge(uuid)`
- `delete_episode(uuid)`
- `clear_graph(group_ids)`
- `get_status()`

UUID-based reads/deletes are global unless the proxy first verifies that the
object belongs to the current `group_id`. `clear_graph` must never be available
to the model as a general user-session tool.

**Fix:** Implement the proxy as a strict allowlist. For v1, expose only:

- `add_memory`, with `group_id` forcibly set to current user,
- `search_nodes`, with `group_ids` forcibly set to `[currentGroupId]`,
- `search_memory_facts`, with `group_ids` forcibly set to `[currentGroupId]`,
- optionally `get_episodes`, with `group_ids` forcibly set to `[currentGroupId]`.

Hide deletes, status, clear, and any raw graph operations from the model. Put
erasure behind an admin-only operation.

### 3. `center_node_uuid` is a subtle side channel

`search_memory_facts` accepts `center_node_uuid`. Even when result filtering is
group-scoped, an arbitrary foreign UUID can influence ranking or produce
observable errors.

**Fix:** Strip `center_node_uuid` in v1, or only allow it after verifying the
center node belongs to the current `group_id`.

### 4. Telegram identity must use the human sender, not always `chat_id`

For Telegram DMs, `chat_id` may be acceptable. In groups, `chat_id` is the group
conversation. If per-user memory is desired, the canonical key should come from
the sender (`from.id`), not the group chat.

**Fix:** Define Telegram keys as `tg:<from.id>` for per-user memory. If group
memory is desired later, make it a separate namespace such as
`tg-group:<chat.id>`.

### 5. Separate `tg:` and `app:` namespaces are acceptable for launch

The same human may get two scopes: one for Telegram, one for the Havaya app. The
blast radius is degraded UX and fragmented memory, not cross-user leakage, as
long as linking is explicit and server-side.

**Fix:** Launch with separate namespaces if needed, but keep linking in one
canonical identity resolver before Graphiti calls. OpenClaw already has a
`session.identityLinks` concept for platform-prefixed identities; reuse or
extend that instead of hiding a separate mapping inside the Graphiti proxy.

### 6. Per-user erasure is broader than dropping one Graphiti group

Dropping a Graphiti `group_id` removes graph memory for that namespace, but user
data can also live in user-files, transcripts, logs, backups, and provider-side
LLM/embedding traces.

**Fix:** Define erasure as a multi-store operation covering:

- Graphiti group data,
- per-user markdown files,
- session transcripts linked to app/Telegram identity,
- operational logs where feasible,
- backup retention policy,
- provider data-retention expectations.

### 7. User-file should remain the visible artifact

Graphiti is a recall/indexing layer, not a deterministic document store. It is
not ideal as the sole source for "show me my file" because generated graph facts
can be lossy, temporal, or model-derived.

**Fix:** Keep the user-file as the human-readable artifact. Let Graphiti power
recall and optionally generate/update summaries that are written into the
user-file through explicit, scoped tools.

## Open questions to add to the plan

1. How exactly does `mcp-bridge` pass current session identity to the MCP server
   or proxy?
2. Are Telegram group chats supported for per-user memory, and if yes, is the
   identity `from.id`?
3. What exact Graphiti tool surface is allowed for `life` v1?
4. Is `center_node_uuid` disabled or group-verified?
5. What is the erasure contract across Graphiti, user-files, transcripts, logs,
   backups, and external providers?
6. Should memory writes be automatic every turn, or filtered/summarized to avoid
   storing secrets and low-value transcript noise?
7. Is there any migration/backfill path from existing user-files into Graphiti?
8. Are Graphiti LLM/embedding providers allowed to see all raw episode text, or
   should memory writes be redacted/summarized before extraction?

## Recommended edits to the plan before implementation

1. Change Phase 3 to: create or update
   `/root/.openclaw/agents/life/openclaw.json`; missing config is expected.
2. Replace "thin wrapper" language for the scoping proxy with "allowlist proxy /
   capability boundary."
3. Name the safe Graphiti tools that will be exposed and the unsafe ones that
   will be hidden.
4. Specify how per-session identity reaches the proxy.
5. Clarify Telegram identity as sender-based for per-user memory.
6. Expand erasure from "drop group_id namespace" to a multi-store deletion
   workflow.
7. State that user-file remains the visible artifact and Graphiti is the recall
   engine.

