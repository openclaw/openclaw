---
summary: "Five-PR task breakdown for closing OpenClaw ACP bridge and ACPX protocol gaps."
read_when:
  - Implementing full ACP bridge protocol support
  - Auditing OpenClaw ACP compatibility against the upstream Agent Client Protocol
  - Adding ACP session close, resume, per-session MCP, filesystem, terminal, or permission relay behavior
  - Reviewing ACPX runtime protocol parity
title: "ACP protocol implementation PR plan"
sidebarTitle: "ACP protocol PR plan"
---

# ACP protocol implementation PR plan

OpenClaw has two ACP surfaces:

- `openclaw acp`: an editor-facing ACP server that bridges ACP clients to a Gateway session.
- ACPX runtime sessions: OpenClaw-owned `/acp spawn` and `sessions_spawn({ runtime: "acp" })` sessions that run external ACP harnesses.

This task list targets protocol-complete bridge behavior first. ACPX stays plugin-owned, but needs a compatibility audit so the bridge and runtime do not drift from current ACP v1 expectations.

## Goals

- Make advertised `openclaw acp` capabilities match working handlers.
- Implement the stable ACP v1 bridge surface where OpenClaw can safely honor it.
- Keep ACPX external-harness orchestration separate from editor-facing bridge semantics.
- Preserve current Gateway-backed session routing for existing users.
- Prefer additive compatibility behavior over removing existing CLI flags or `_meta` routing.

## Non-goals

- Do not implement unstable ACP features unless a stable feature depends on the same seam.
- Do not replace native Codex plugin binding with ACP by default.
- Do not move ACPX adapter-specific behavior into core.
- Do not implement remote HTTP or WebSocket ACP transport in this pass.

## PR 1: Bridge protocol baseline and session lifecycle

Scope: make the advertised stable ACP bridge surface match real handlers, then add the missing low-risk session lifecycle methods. This PR should not add new filesystem, terminal, permission, or MCP execution surface.

- [x] Confirm the current upstream stable ACP schema and TypeScript SDK version.
  - Acceptance: `package.json` pins the intended `@agentclientprotocol/sdk` version, and the task PR explains why any upgrade is or is not needed.
- [x] Add a protocol fixture test that validates representative `initialize`, `session/new`, `session/prompt`, `session/update`, `session/list`, `session/resume`, and `session/close` payloads against the SDK schema.
  - Acceptance: malformed payload fixtures fail in the test, so the test proves schema validation is active.
- [x] Add a capability invariant test for `AcpGatewayAgent.initialize`.
  - Acceptance: every advertised capability has a corresponding handler and every unsupported handler is absent from advertised capabilities.
- [x] Fix `session/list` handler naming.
  - Current risk: the bridge implements `unstable_listSessions`; current SDK dispatch expects `listSessions`.
  - Acceptance: an SDK client calling `client.listSessions(...)` reaches the OpenClaw bridge handler.
- [x] Implement cursor-aware `session/list`.
  - Acceptance: `cwd` filtering is honored, page size is bounded, cursors are opaque, and `nextCursor` is returned only when more rows exist.
- [x] Implement `session/resume`.
  - Acceptance: resume rebinds the ACP session to the Gateway session key without replaying history, returns current `configOptions` and `modes`, and advertises `sessionCapabilities.resume`.
- [x] Implement `session/close`.
  - Acceptance: close aborts any active turn, resolves any pending prompt as cancelled, removes the bridge session from the in-memory store, releases bridge-owned relay resources, and advertises `sessionCapabilities.close`.
- [x] Add close and resume compatibility tests for missing sessions.
  - Acceptance: missing sessions return a clear JSON-RPC error and do not leave dangling pending prompt entries.

Verification for this PR:

- [x] Unit: `src/acp/translator*.test.ts` covers advertised capability invariants and stable handler dispatch.
- [x] Unit: bridge session store tests cover close, resume, active-run cleanup, and missing-session errors.
- [ ] Integration: built-in ACP client can run new, prompt, cancel, list, resume, and close.

Follow-up surface intentionally left for later PRs: `session/load` replay fidelity, ACP client relays, per-session MCP, rich content updates, and ACPX runtime parity.

## PR 2: Complete load replay and event ledger

Scope: make `session/load` deterministic and honest by introducing a bridge-owned ACP event ledger. This PR should not add new client relays or MCP process management.

- [ ] Add a bridge ACP event ledger.
  - Acceptance: every bridge-emitted `session/update` can be persisted in order by ACP session id and Gateway run id.
- [ ] Record full prompt-turn events.
  - Acceptance: user chunks, assistant chunks, thought chunks, tool calls, tool call updates, plan updates, config updates, usage updates, and session info updates are represented when available.
- [ ] Change `session/load` to prefer ledger replay.
  - Acceptance: loading a session with a complete ledger replays all ACP events in original order before returning.
- [ ] Define incomplete-ledger behavior.
  - Acceptance: sessions without complete ACP replay data either return a clear load error with a resume hint or use an explicitly documented compatibility mode.
- [ ] Bound ledger size and retention.
  - Acceptance: retention policy prevents unbounded state growth and does not break active sessions.

Verification for this PR:

- [ ] Unit: ledger tests cover ordering, session scoping, run scoping, truncation, and active-session retention.
- [ ] Unit: translator tests cover replay for assistant text, thought text, tools, plan updates, config updates, usage updates, and session info updates.
- [ ] Integration: loading a ledger-backed ACP session reconstructs full event history before returning.
- [ ] Compatibility: loading a session without complete replay data follows the documented fallback or error path.

Follow-up surface intentionally left for later PRs: filesystem relay, terminal relay, permission relay, per-session MCP, and ACPX runtime parity.

## PR 3: Client filesystem, terminal, and permission relays

Scope: connect ACP client capabilities to Gateway tool execution through explicit bridge relay routing. This is the first PR that adds new execution surface, so it should be security-reviewed independently.

- [ ] Capture client capabilities during `initialize`.
  - Acceptance: each ACP session knows whether its client advertised filesystem and terminal support.
- [ ] Add a bridge relay id to `chat.send` provenance or metadata.
  - Acceptance: Gateway can route bridge-owned tool requests back to the correct ACP connection and session.
- [ ] Implement ACP client filesystem relay.
  - Tasks: `fs/read_text_file`, `fs/write_text_file`.
  - Acceptance: Gateway-side tools call the ACP client only when the client advertised `fs.readTextFile` or `fs.writeTextFile`.
- [ ] Implement ACP client terminal relay.
  - Tasks: `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`.
  - Acceptance: terminal ids are session-scoped, released on `session/close`, and never leaked into unrelated Gateway sessions.
- [ ] Implement permission relay.
  - Acceptance: Gateway approval requests can map to ACP `session/request_permission`, and `session/cancel` answers outstanding permission requests with ACP `cancelled`.
- [ ] Add relay failure semantics.
  - Acceptance: disconnected ACP clients fail closed for mutating filesystem, terminal, and permission requests.

Verification for this PR:

- [ ] Unit: relay routing tests prove filesystem, terminal, and permission calls are scoped to the correct ACP connection and session.
- [ ] Unit: disconnect tests prove mutating filesystem, terminal, and permission requests fail closed.
- [ ] Integration: an ACP editor client can receive filesystem reads/writes, terminal lifecycle calls, and permission prompts from one session without leaking to another.
- [ ] Live smoke: an ACP editor client can start a session, run a tool that needs terminal or filesystem access, answer a permission request, cancel the turn, and close the session cleanly.

Follow-up surface intentionally left for later PRs: per-session MCP, richer diff/resource content, image/audio capability cleanup, and ACPX runtime parity.

## PR 4: Per-session MCP and rich bridge content

Scope: add session-scoped MCP support and improve ACP content/update fidelity after the relay model is already in place. This PR is allowed to touch execution surface for MCP only.

- [ ] Stop rejecting non-empty `mcpServers` in bridge session setup.
  - Acceptance: `session/new`, `session/load`, and `session/resume` accept stdio MCP server definitions.
- [ ] Validate MCP server definitions.
  - Acceptance: invalid or unsafe server definitions fail before Gateway execution, secrets are redacted in logs, and command path requirements match ACP.
- [ ] Add a session-scoped MCP overlay.
  - Acceptance: MCP servers passed by the ACP client are available only to the target bridge session.
- [ ] Manage MCP process lifecycle.
  - Acceptance: MCP server processes start on session setup, stop on `session/close`, and are cleaned up on ACP connection shutdown.
- [ ] Keep HTTP and SSE MCP capabilities disabled until implemented.
  - Acceptance: `mcpCapabilities.http` and `mcpCapabilities.sse` remain false unless corresponding transports are supported end to end.

- [ ] Map OpenClaw plan state to ACP `plan` updates.
  - Acceptance: clients receive complete replacement plan entries with `pending`, `in_progress`, or `completed` status.
- [ ] Map file edits to ACP diff content when possible.
  - Acceptance: tool call content can include ACP `diff` entries with `path`, `oldText`, and `newText`.
- [ ] Embed ACP terminal content for relayed terminal commands.
  - Acceptance: tool calls created from ACP client terminals include `{ type: "terminal", terminalId }` before terminal release.
- [ ] Improve stop reason mapping.
  - Acceptance: Gateway end states map to ACP `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, and `cancelled` where the information exists.
- [ ] Preserve raw fallback output.
  - Acceptance: Gateway-local tools still produce useful text and raw output when no richer ACP representation exists.

- [ ] Preserve embedded resource metadata.
  - Acceptance: `resource` and `resource_link` prompt blocks do not lose name, URI, MIME type, or title information during Gateway projection.
- [ ] Keep image capability conditional.
  - Acceptance: `promptCapabilities.image` is advertised only when the Gateway attachment path is active.
- [ ] Keep audio unsupported until a real path exists.
  - Acceptance: `promptCapabilities.audio` remains false and audio prompt blocks are rejected clearly.
- [ ] Validate absolute working directories.
  - Acceptance: `cwd` validation matches ACP requirements and reports a clear error for relative paths.

Verification for this PR:

- [ ] Unit: MCP validation tests cover invalid definitions, redacted log output, stdio-only support, and rejected HTTP/SSE transports.
- [ ] Unit: MCP lifecycle tests prove processes start on session setup and stop on `session/close` or ACP connection shutdown.
- [ ] Unit: content translator tests cover plan updates, diff entries, terminal content entries, resource metadata, conditional image capability, audio rejection, and absolute `cwd` validation.
- [ ] Integration: a session-scoped MCP tool is available only inside its bridge session.
- [ ] Integration: tool output can include ACP diff and terminal content while preserving useful text fallback output.

Follow-up surface intentionally left for later PRs: ACPX runtime package audit and public docs updates that depend on completed behavior.

## PR 5: ACPX runtime audit, compatibility docs, and final smoke

Scope: audit the OpenClaw ACPX runtime against the bridge behavior, decide whether to upgrade `acpx`, and update user-facing compatibility docs after the bridge implementation has landed.

- [ ] Audit `acpx` package version drift.
  - Acceptance: document whether OpenClaw should keep the current pin or upgrade, including observed API or behavior changes relevant to `ensureSession`, `runTurn`, `cancel`, `close`, `setMode`, and `setConfigOption`.
- [ ] Audit ACPX `ensureSession` against current `session/new`, `session/load`, and `session/resume` semantics.
- [ ] Audit ACPX `close` against stable `session/close` semantics.
- [ ] Audit ACPX model and config control translation.
- [ ] Audit ACPX MCP injection behavior.
- [ ] Decide whether to upgrade `acpx`.
  - Acceptance: upgrade decision includes tests for Codex ACP, Claude ACP, OpenClaw ACP bridge target, and at least one generic adapter when available.
- [ ] Update `docs/cli/acp`.
  - Acceptance: the compatibility matrix reflects the implemented bridge behavior and still distinguishes unsupported transports or prompt block types.
- [ ] Update `docs/tools/acp-agents`.
  - Acceptance: ACPX runtime docs reflect any audited behavior change, package upgrade, or intentionally unsupported feature.
- [ ] Add a changelog entry if any previous PR changed user-visible behavior without one.
  - Acceptance: changelog credits use the repo-required contributor format.

Verification for this PR:

- [ ] ACPX smoke: `/acp doctor`, spawn, prompt, status, cancel, close, resume, and config controls pass for supported local harnesses.
- [ ] Bridge live smoke: an ACP editor client can start a session, prompt, cancel, resume, close, and see tool progress.
- [ ] Docs: updated ACP docs match the actual capabilities advertised by `initialize`.
- [ ] Release notes: any user-visible compatibility improvements are represented once and only once in the changelog.

## Cross-PR verification matrix

- PR 1 proves stable bridge lifecycle correctness without new execution surface.
- PR 2 proves replay correctness without new execution surface.
- PR 3 proves ACP client relay execution is scoped, cancellable, and fail-closed.
- PR 4 proves MCP execution is session-scoped and rich content projection is backwards-compatible.
- PR 5 proves ACPX compatibility and public docs match the final behavior.

## Suggested implementation order

1. PR 1 first. It is the smallest compatibility fix and establishes the capability invariant test that later PRs must preserve.
2. PR 2 second. Complete replay should land before richer relay behavior so replay has one canonical event source.
3. PR 3 third. It adds filesystem, terminal, and permission execution paths and should be reviewed as a security-sensitive PR.
4. PR 4 fourth. It adds MCP execution and richer content projection after the bridge relay model exists.
5. PR 5 last. It uses the completed bridge behavior as the baseline for ACPX audit, compatibility docs, and final smoke proof.

## PR boundary rules

- Each PR should be mergeable independently in the order above.
- Each PR should include tests for its own behavior and should not depend on unmerged code from a later PR.
- PRs 1 and 2 should avoid new execution surface.
- PRs 3 and 4 should be security-reviewed because they introduce relay or MCP execution surface.
- Docs should change in the same PR as behavior when the behavior is user-visible; PR 5 is for final compatibility docs and ACPX-specific docs that need the full implementation context.
- Changelog entries should appear in the first PR that introduces user-visible behavior, not deferred to PR 5 unless the earlier PR was intentionally internal only.

## Handoff notes

- Keep `openclaw acp` bridge docs separate from `/acp spawn` ACPX harness docs.
- Keep core extension-agnostic. ACPX-specific process, adapter, and package behavior stays under `extensions/acpx`.
- Update `docs/cli/acp` as each compatibility matrix entry changes.
- Update `docs/tools/acp-agents` only when ACPX runtime behavior changes.
- Add changelog entries only for user-visible behavior changes, not for this planning file.
