# Malformed Subagent Output — Wave 0 Source Map

Date: 2026-05-18
Plan: `/root/.openclaw/repos/openclaw-mds/handoffs/framework/current/malformed-subagent-output-fix-plan-2026-05-16.md`
Worktree: `/root/.openclaw/worktrees/openclaw-runtime-hardening-20260517`
Scope: source-map/test-inventory/release-surface gate only. No Plan 2 runtime implementation was performed.

## Gate verdict

Wave 0 P0 mapping is complete and checker-ready. All raw-output-to-parent, compaction/memory/prompt-reconstruction, and child-result acceptance paths named by the Plan 2 document are mapped to real source paths, owning modules, call chains, existing tests, and later-wave test additions.

No live gateway config/runtime was touched. No gateway restart was performed or required. Package files, lockfiles, generated/bundled output, credentials, cron jobs, and external messaging were not touched.

## Explicit generated artifact / dist no-patch rule

Do **not** manually patch bundled/generated/hashed `dist` artifacts. Installed `dist/index.js` and bundled sourcemap breadcrumbs are source-map evidence only. Later waves may edit source and tests; generated release artifacts may change only through the accepted reproducible source build described in `docs/plan/malformed-subagent-output-wave0-release-surface-20260518.md`.

## Evidence inputs

- Plan requirements: `malformed-subagent-output-fix-plan-2026-05-16.md` Wave 0.
- Source inspection logs under `/tmp`, notably:
  - `/tmp/malformed-wave0-symbol-index.log`
  - `/tmp/malformed-wave0-focused-tests-targeted.log`
  - `/tmp/malformed-wave0-ui-tests.log`
  - `/tmp/malformed-wave0-compaction-key-lines.log`
  - `/tmp/malformed-wave0-chat-sanitize-symbols.log`
  - `/tmp/malformed-wave0-release-scripts-concise.log`
- Current dirty source/package state was treated as pre-existing Plan 1/other-wave work and not rewritten.

## P0 source-map summary

| Required surface                                       | P0 status | Owning source files                                                                                                                                                                                                                                            | Existing focused tests                                                                                                                                                                                                                             | Later-wave implementation packet                                                                                            |
| ------------------------------------------------------ | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Output selection/fallback capture                      |  complete | `src/agents/subagent-announce-output.ts`, `src/agents/subagent-announce-capture.ts`                                                                                                                                                                            | `src/agents/subagent-announce-output.test.ts`, `src/agents/subagent-announce.capture-completion-reply.test.ts`, `src/agents/subagent-announce.test.ts`, `src/agents/subagent-announce.timeout.test.ts`                                             | Gate latest silent/assistant/raw/fallback text through normalized result parser/quarantine before parent-visible text.      |
| Raw child-result wrapping/classification               |  complete | `src/agents/subagent-child-result-contract.ts`, `src/agents/subagent-active-task-contract.ts`                                                                                                                                                                  | `src/agents/subagent-child-result-contract.test.ts`, `src/agents/subagent-active-task-contract.test.ts`                                                                                                                                            | Make normalized states/labels authoritative; add `VERIFIED_PASS` evidence gate semantics and adversarial fixtures.          |
| Announce flow and delivery                             |  complete | `src/agents/subagent-announce.ts`, `src/agents/subagent-announce-delivery.ts`, `src/agents/subagent-announce-dispatch.ts`, `src/gateway/server-methods/agent.ts`                                                                                               | `src/agents/subagent-announce.test.ts`, `src/agents/subagent-announce-delivery.test.ts`, `src/agents/subagent-announce-dispatch.test.ts`, `src/gateway/server.agent.subagent-delivery-context.test.ts`, `src/gateway/server-methods/agent.test.ts` | Enforce metadata-only delivery consistently for direct, queued, fallback, cron/background, and nested subagent paths.       |
| Internal event formatting and prompt reconstruction    |  complete | `src/agents/internal-event-contract.ts`, `src/agents/internal-events.ts`, `src/agents/internal-runtime-context.ts`, `src/agents/command/attempt-execution.shared.ts`, `src/agents/agent-command.ts`                                                            | `src/agents/internal-events.test.ts`, `src/agents/agent-command.live-model-switch.test.ts`, `src/commands/agent.test.ts`                                                                                                                           | Ensure internal completion events carry status cards/metadata only and are stripped from persisted/display contexts.        |
| Announce idempotency/dedupe                            |  complete | `src/agents/announce-idempotency.ts`, `src/agents/subagent-registry-completion-dedupe.ts`, `src/agents/subagent-announce.ts`, `src/agents/subagent-active-task-contract.ts`                                                                                    | `src/agents/subagent-registry-completion.test.ts`, `src/agents/subagent-registry.announce-loop-guard.test.ts`, `src/agents/subagent-announce.test.ts`, `src/agents/subagent-child-result-contract.test.ts`                                         | Dedupe by child run/session/hash and verify duplicate events never create a second parent-visible raw payload.              |
| Compaction/successor transcript summaries              |  complete | `src/agents/compaction.ts`, `src/agents/pi-hooks/compaction-safeguard.ts`, `src/agents/pi-hooks/compaction-safeguard-quality.ts`, `src/agents/pi-embedded-runner/compaction-successor-transcript.ts`, `src/agents/pi-embedded-runner/transcript-file-state.ts` | `src/agents/compaction.test.ts`, `src/agents/compaction.tool-result-details.test.ts`, `src/agents/pi-hooks/compaction-safeguard.test.ts`, `src/agents/pi-embedded-runner/compaction-successor-transcript.test.ts`                                  | Add deterministic child-result sanitizer before summarizer/provider/LLM/successor transcript write.                         |
| Memory extraction / summary sanitation                 |  complete | `packages/memory-host-sdk/src/host/session-files.ts`, `packages/memory-host-sdk/src/host/openclaw-runtime.ts`, `packages/memory-host-sdk/src/host/openclaw-runtime-session.ts`                                                                                 | `packages/memory-host-sdk/src/host/session-files.test.ts`, `packages/memory-host-sdk/src/host/session-files-yield.test.ts`, `src/agents/system-prompt.memory.test.ts`, `src/agents/memory-search.test.ts`                                          | Sanitize child completion artifacts before session export, memory extraction, embeddings/vector-store, and search snippets. |
| Control UI/TUI rendering of internal completion events |  complete | `src/gateway/chat-display-projection.ts`, `src/gateway/live-chat-projector.ts`, `src/gateway/session-history-state.ts`, `ui/src/ui/chat/message-extract.ts`, `ui/src/ui/controllers/chat.ts`, `src/gateway/protocol/schema/agent.ts`                           | `src/gateway/session-history-state.test.ts`, `src/gateway/server.agent.subagent-delivery-context.test.ts`, `ui/src/ui/chat/message-extract.test.ts`, `ui/src/ui/controllers/chat.test.ts`, `ui/src/ui/chat/build-chat-items.test.ts`               | Render completion as collapsed status card/metadata; default UI must not show raw source/diff/log payloads.                 |
| Harness acceptance/finalizer/verdict handling          |  complete | Runtime-owned in `src/agents/subagent-child-result-contract.ts`, `src/agents/subagent-active-task-contract.ts`, `src/agents/subagent-announce.ts`, `src/gateway/server-methods/agent.ts`; no separate harness module was required for P0 mapping.              | `src/agents/subagent-child-result-contract.test.ts`, `src/agents/subagent-active-task-contract.test.ts`, `src/gateway/protocol/schema/agent.test.ts`, `src/commands/agent.test.ts`                                                                 | Add evidence verifier/finalizer gates so only parent/runtime-verified `VERIFIED_PASS` can satisfy acceptance.               |

## Detailed surface mapping

### 1. Output selection and fallback capture

**Breadcrumbs mapped:** `src/agents/subagent-announce-output.ts`, `src/agents/subagent-session-cleanup.ts` installed-runtime region.

**Owning module/package:** runtime agent/subagent announce output capture.

**Source files and symbols:**

- `src/agents/subagent-announce-output.ts`
  - `selectSubagentOutputText` chooses `latestSilentText`, `latestAssistantText`, partial progress, then `snapshot.latestRawText`.
  - `readSubagentOutput` calls `chat.history`, summarizes the child transcript, then falls back to latest assistant reply.
  - `readLatestSubagentOutputWithRetry`, `waitForSubagentRunOutcome`, `applySubagentWaitOutcome`, `captureSubagentCompletionReply` coordinate wait/retry capture.
  - `formatChildResultData`, `buildChildCompletionFindings`, `dedupeLatestChildCompletionRows`, `filterCurrentDirectChildCompletionRows` aggregate descendant/frozen results.
- `src/agents/subagent-announce-capture.ts`
  - `readLatestSubagentOutputWithRetryUsing`, `captureSubagentCompletionReplyUsing` provide injectable capture helpers for tests.
- `src/agents/subagent-session-cleanup.ts`
  - `deleteSubagentSessionForCleanup` is the cleanup endpoint after announce/capture, not an output-selection owner.

**Call chain:** `runSubagentAnnounceFlow` → `waitForSubagentRunOutcome`/embedded wait → `readSubagentOutput` or `buildChildCompletionFindings` → `formatChildResultData` → `buildParentVisibleChildResult` → internal event/delivery.

**Current tests:** `src/agents/subagent-announce-output.test.ts`, `src/agents/subagent-announce.capture-completion-reply.test.ts`, `src/agents/subagent-announce.test.ts`, `src/agents/subagent-announce.timeout.test.ts`.

**New tests required:** adversarial latestRawText, partial progress, silent reply, empty output, source/diff/log fallback, timeout/cancelled fallback, and descendant frozen-result aggregation where raw payload becomes metadata/quarantine only.

### 2. Raw child-result wrapping, parser/classification, and active task acceptance evidence

**Breadcrumbs mapped:** `formatUntrustedChildResult`, `buildChildCompletionFindings`, raw child-result wrapping, schema/file-backed verdict handling.

**Owning module/package:** runtime subagent result contract and active task contract.

**Source files and symbols:**

- `src/agents/subagent-child-result-contract.ts`
  - Classification constants: `CHILD_RESULT_SCHEMA_VALID`, `CHILD_RESULT_EVIDENCE_UNVERIFIED`, `CHILD_RESULT_TASK_CONTRACT_MISSING`, `CHILD_RESULT_MALFORMED_RAW_SOURCE_OUTPUT`, `CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT`, `CHILD_RESULT_DUPLICATE_COMPLETION`, `CHILD_RESULT_RETRY_ALLOWED`, `CHILD_RESULT_RETRY_POLICY_EXHAUSTED`.
  - `parseChildResultReport`, `classifyChildResultContract`, `quarantineChildResultOutput`, `formatChildResultContractSummaryForParent`, `buildParentVisibleChildResult`.
  - `looksLikeToolLogOutput`, `looksLikeRawSourceOutput`, `verifyExpectedArtifacts`, `scopeDisagreement`, `unverifiedScopedGateEvidence` are the core acceptance downgrades.
- `src/agents/subagent-active-task-contract.ts`
  - `ACTIVE_TASK_CONTRACT`, `SCHEMA_VALID`, `EVIDENCE_UNVERIFIED`, `TASK_CONTRACT_MISSING` vocabulary.
  - `normalizeActiveTaskContract`, `validateActiveTaskContractForAcceptance`, `preflightActiveTaskExpectedOutputArtifacts`, `classifyChildCompletionAgainstActiveTask`, `buildActiveTaskChildCompletionDedupeKey`, `buildActiveTaskStatusCardData`.

**Call chain:** child final text/frozen text → `buildParentVisibleChildResult` → `classifyChildResultContract` → optional artifact verification/scope checks/quarantine → parent-visible summary/status-card data.

**Current tests:** `src/agents/subagent-child-result-contract.test.ts`, `src/agents/subagent-active-task-contract.test.ts`, `src/agents/subagent-announce-output.test.ts`, `src/agents/subagent-announce.test.ts`.

**New tests required:** strict JSON, fenced JSON, prose+JSON, invalid/truncated JSON, legacy `PASS`/`FAIL`, missing verdict, raw source/diff/log/grep, binary/ANSI/unicode, oversized output, path traversal/symlink/out-of-scope/stale artifacts, and schema-valid `PASS` without parent/runtime evidence must become `EVIDENCE_UNVERIFIED`/non-success until `VERIFIED_PASS` is added.

### 3. Subagent announce flow and direct/queued/fallback delivery

**Breadcrumbs mapped:** `src/agents/subagent-announce.ts`, `src/agents/subagent-announce-delivery.ts`, `src/agents/subagent-announce-dispatch.ts`, provenance `sourceTool=subagent_announce`.

**Owning module/package:** runtime subagent announce pipeline and gateway agent dispatch.

**Source files and symbols:**

- `src/agents/subagent-announce.ts`
  - `runSubagentAnnounceFlow` is the main orchestrator.
  - `buildAnnounceReplyInstruction`, `buildAnnounceSteerMessage`, `stripAndClassifyReply`, `wakeSubagentRunAfterDescendants`, `resolveChildCompletionDeliveryPolicy`, `buildChildCompletionDeliveryDecision`, `buildCompletionStatusCard`.
  - Calls `parseChildResultReport`, `buildParentVisibleChildResult`, dedupe begin/mark, and `deliverSubagentAnnouncement`.
- `src/agents/subagent-announce-delivery.ts`
  - `deliverSubagentAnnouncement`, `sendSubagentAnnounceDirectly`, `runAnnounceDeliveryWithRetry`, `resolveSubagentCompletionOrigin`, `resolveSubagentAnnounceTimeoutMs`.
  - Direct agent calls set `inputProvenance.kind="inter_session"`, `sourceTool="subagent_announce"`, and the direct idempotency key.
- `src/agents/subagent-announce-dispatch.ts`
  - `runSubagentAnnounceDispatch`, `mapSteerOutcomeToDeliveryResult` choose steer-primary, direct-primary, and steer-fallback phases.
- `src/gateway/server-methods/agent.ts`
  - `shouldSuppressAgentPromptPersistence` suppresses persistence for subagent task-completion inter-session prompts.
  - `dispatchAgentRunFromGateway`, idempotency/dedupe, tracked task finalization, and agent request handling are the gateway ingress points.

**Call chain:** child completes → `runSubagentAnnounceFlow` captures/normalizes result → `formatAgentInternalEventsForPrompt` creates trigger/steer body → `deliverSubagentAnnouncement` → queued wake or `agent` gateway call → requester/session/UI projection.

**Current tests:** `src/agents/subagent-announce.test.ts`, `src/agents/subagent-announce-delivery.test.ts`, `src/agents/subagent-announce-dispatch.test.ts`, `src/agents/subagent-announce.format.e2e.test.ts`, `src/gateway/server.agent.subagent-delivery-context.test.ts`, `src/gateway/server-methods/agent.test.ts`.

**New tests required:** direct vs queued vs fallback equivalence for source/diff/log/empty/duplicate outputs, cron/background completions, active requester queue failure fallback, nested subagent handoff, and persistence suppression of internal prompts.

### 4. Internal event formatting and prompt reconstruction

**Breadcrumbs mapped:** `src/agents/internal-events.ts`, internal envelope handling, prompt reconstruction.

**Owning module/package:** agent prompt assembly and runtime context stripping.

**Source files and symbols:**

- `src/agents/internal-event-contract.ts`
  - `AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION`, `AGENT_TASK_COMPLETION_DELIVERY_STATES`, `AGENT_TASK_COMPLETION_DELIVERY_ACTIONS`, `AgentTaskCompletionQuarantineMetadata`, `AgentTaskCompletionDedupeMetadata`, and `AgentTaskCompletionStatusCard` define the status-card contract used by formatter/delivery/UI surfaces.
- `src/agents/internal-events.ts`
  - `formatAgentInternalEventsForPrompt`, `formatAgentInternalEventsForPlainPrompt`, `formatTaskCompletionEvent`, `formatTaskCompletionEventForPlainPrompt`, `formatStatusCardDataBlock`, `formatSuppressedChildResultSummaryForPrompt`, `resolveParentVisibleInternalEventBudget`.
  - Uses `INTERNAL_RUNTIME_CONTEXT_BEGIN` / `INTERNAL_RUNTIME_CONTEXT_END` from `src/agents/internal-runtime-context.ts`.
- `src/agents/internal-runtime-context.ts`
  - `stripInternalRuntimeContext`, `hasInternalRuntimeContext`, `stripRuntimeContextCustomMessages`, `stripHistoricalRuntimeContextCustomMessages`, `escapeInternalRuntimeContextDelimiters`.
  - Also strips legacy `BEGIN_UNTRUSTED_CHILD_RESULT`/`END_UNTRUSTED_CHILD_RESULT` blocks.
- `src/agents/command/attempt-execution.shared.ts`
  - `prependInternalEventContext`, `resolveAcpPromptBody`, `resolveInternalEventTranscriptBody`, `persistSessionEntry`.
- `src/agents/agent-command.ts`
  - `prepareAgentCommandExecution` applies `resolveAcpPromptBody`, `prependInternalEventContext`, and `resolveInternalEventTranscriptBody` before running/persisting the agent turn.

**Call chain:** announce creates `AgentInternalEvent` → internal-events formatter → attempt-execution prompt/body resolver → agent-command/gateway agent run → transcript history and live UI projection.

**Current tests:** `src/agents/internal-events.test.ts`, `src/agents/agent-command.live-model-switch.test.ts`, `src/commands/agent.test.ts`, `src/gateway/server-methods/agent.test.ts`.

**New tests required:** status-card-only events, delivery-state/action vocabulary (`MALFORMED_QUARANTINED`, `UNVERIFIED`, `EVIDENCE_UNVERIFIED`, `NOT_ACCEPTANCE_EVIDENCE`, `DUPLICATE_ANNOUNCE_SUPPRESSED`, `INFRA_BLOCKED`) maps to non-success UI/runtime behavior, delimiter escaping, budget truncation without snippets, plain prompt vs runtime envelope parity, transcript body strips internal context, and legacy marker repair with exact identifiers preserved.

### 5. Announce idempotency and duplicate suppression

**Breadcrumbs mapped:** `src/agents/announce-idempotency.ts`, duplicate announcement handling.

**Owning module/package:** subagent announce runtime and registry persistence.

**Source files and symbols:**

- `src/agents/announce-idempotency.ts`: `buildAnnounceIdFromChildRun`, `buildAnnounceIdempotencyKey`.
- `src/agents/subagent-registry-completion-dedupe.ts`: `beginSubagentCompletionDedupe`, `markSubagentCompletionDedupeDelivered`, counter/state records.
- `src/agents/subagent-registry-runtime.ts`: exports registry read/write/dedupe runtime functions.
- `src/agents/subagent-announce.ts`: `latestRegistryRunIndicatesDuplicateCompletion`, `buildChildCompletionDedupeDecision`, registry begin/mark integration.
- `src/agents/subagent-active-task-contract.ts`: `buildActiveTaskChildCompletionDedupeKey`.

**Call chain:** `runSubagentAnnounceFlow` derives child run/session/result identity → local + registry dedupe begin → direct idempotency key → delivery → registry mark delivered → duplicate retries suppress parent-visible payload.

**Current tests:** `src/agents/subagent-registry-completion.test.ts`, `src/agents/subagent-registry.announce-loop-guard.test.ts`, `src/agents/subagent-registry.persistence.resume.test.ts`, `src/agents/subagent-announce.test.ts`, `src/agents/subagent-child-result-contract.test.ts`.

**New tests required:** duplicate same `(childRunId, childSessionKey, payloadHash)` across direct/queued/restart/resume, backgrounded duplicate child task mismatch, and `DUPLICATE_ANNOUNCE_SUPPRESSED` status-card rendering.

### 6. Compaction and successor transcript summaries

**Breadcrumbs mapped:** `src/agents/compaction.ts`, `src/agents/compaction-real-conversation.ts`, `src/agents/pi-hooks/compaction-safeguard.ts`, `src/agents/pi-embedded-runner/compaction-successor-transcript.ts`.

**Owning module/package:** runtime compaction, PI embedded runner transcript rotation, and compaction quality guard.

**Source files and symbols:**

- `src/agents/compaction.ts`
  - `estimateMessagesTokens`, `summarizeWithFallback`, `summarizeInStages`, `pruneHistoryForContextShare`, `summarizeForHandoff`.
  - Uses `stripToolResultDetails(stripRuntimeContextCustomMessages(...))` before token estimation and summarization chunks.
- `src/agents/pi-hooks/compaction-safeguard.ts`
  - `session_before_compact` hook strips runtime-context custom messages from `messagesToSummarize` and `turnPrefixMessages`, then routes provider or LLM summaries, preserved turns, split-turn context, tool failures, file ops, and quality verification sections.
  - `collectSessionBranchMessages`, `splitPreservedRecentTurns`, `formatPreservedTurnsSection`, `formatSplitTurnContextSection`, `capCompactionSummaryPreservingSuffix` are sinks where raw child text must be sanitized before summary assembly.
- `src/agents/pi-hooks/compaction-safeguard-quality.ts`
  - `buildCompactionStructureInstructions`, `buildStructuredFallbackSummary`, `auditSummaryQuality`, `buildSummaryVerificationSection`, `wrapUntrustedInstructionBlock`.
- `src/agents/pi-embedded-runner/compaction-successor-transcript.ts`
  - `rotateTranscriptAfterCompaction`, `rotateTranscriptFileAfterCompaction`, `buildSuccessorEntries`, `buildSuccessorHeader` write the post-compaction successor transcript.
- `src/agents/pi-embedded-runner/transcript-file-state.ts`
  - `appendCompaction` / branch summary entry types persist summary text.

**Call chain:** session compaction preparation → runtime-context strip → summarizer/provider prompt → summary/verification sections → transcript state append → optional successor transcript rotation.

**Current tests:** `src/agents/compaction.test.ts`, `src/agents/compaction.tool-result-details.test.ts`, `src/agents/compaction.identifier-preservation.test.ts`, `src/agents/pi-hooks/compaction-safeguard.test.ts`, `src/agents/pi-embedded-runner/compaction-successor-transcript.test.ts`, `src/agents/pi-embedded-runner/compaction-runtime-context.test.ts`.

**New tests required:** deterministic sanitizer fixtures for normal/malformed/nested/split legacy markers, raw source/diff/log without markers, huge logs, prompt injection requesting preservation, provider path and LLM path, preserved recent turns, split-turn prefix, and successor transcript output. This path is P0; no raw-output-to-summary gap is deferred.

### 7. Memory extraction / session export / summary sanitation

**Breadcrumbs mapped:** memory extraction / summary sanitation if separate.

**Owning module/package:** memory host SDK session file reader/exporter.

**Source files and symbols:**

- `packages/memory-host-sdk/src/host/session-files.ts`
  - `collectRawSessionText`, `stripInboundMetadataForUserRole`, `sanitizeSessionText`, `extractSessionText`, `buildSessionEntry`.
  - `sanitizeSessionText` applies `stripInternalRuntimeContext` and `redactSensitiveText` before rendered export/search content.
- `packages/memory-host-sdk/src/host/openclaw-runtime.ts`
  - re-exports `stripInternalRuntimeContext` for host/runtime use.
- `packages/memory-host-sdk/src/host/openclaw-runtime-session.ts`
  - session/runtime integration export surface for host operations.

**Call chain:** transcript file line parse → raw message content collection → inbound metadata strip → internal runtime context strip → redaction → rendered session export/memory index content.

**Current tests:** `packages/memory-host-sdk/src/host/session-files.test.ts`, `packages/memory-host-sdk/src/host/session-files-yield.test.ts`, `packages/memory-host-sdk/src/host/read-file.test.ts`, `src/agents/system-prompt.memory.test.ts`, `src/agents/memory-search.test.ts`.

**New tests required:** polluted session export and memory extraction fixtures, legacy `BEGIN_UNTRUSTED_CHILD_RESULT` stripping, status-card metadata retention, raw quarantine artifact reference handling, and no raw body in search/export snippets.

### 8. Control UI/TUI rendering and session history projection

**Breadcrumbs mapped:** Control UI/TUI rendering of internal completion events.

**Owning module/package:** gateway history projection and web/TUI chat rendering.

**Source files and symbols:**

- `src/gateway/session-history-state.ts`
  - `buildSessionHistorySnapshot`, `SessionHistorySseState`, `toSessionHistoryMessages`, and `projectChatDisplayMessages` integration.
- `src/gateway/chat-display-projection.ts`
  - `projectChatDisplayMessages`, `sanitizeChatHistoryMessages`, `isSubagentAnnounceInterSessionUserMessage`, `filterVisibleProjectedHistoryMessages`, `projectRecentChatDisplayMessages`.
  - Hides inter-session user prompts with `sourceTool=subagent_announce` and strips envelopes before UI history.
- `src/gateway/live-chat-projector.ts`
  - `normalizeLiveAssistantEventText`, `projectLiveAssistantBufferedText`, `shouldSuppressAssistantEventForLiveChat`; strips internal runtime context from live assistant deltas/text.
- `ui/src/ui/chat/message-extract.ts`
  - `extractText`, `extractTextCached`, `extractRawText`; strips internal runtime context before rendering user-visible message text.
- `ui/src/ui/controllers/chat.ts`
  - `loadChatHistory`, `handleChatEvent`, `sendChatMessage`, `shouldHideHistoryMessage` control history/load/live event application.
- `src/gateway/protocol/schema/agent.ts`
  - protocol schema surface for `internalEvents` and gateway agent request/response typing.

**Call chain:** gateway session/transcript raw messages → projection/sanitization → SSE/history snapshot → UI controller → message extract/render → status card/tool-card rendering.

**Current tests:** `src/gateway/session-history-state.test.ts`, `src/gateway/server.agent.subagent-delivery-context.test.ts`, `src/gateway/protocol/schema/agent.test.ts`, `ui/src/ui/chat/message-extract.test.ts`, `ui/src/ui/controllers/chat.test.ts`, `ui/src/ui/chat/build-chat-items.test.ts`, `ui/src/ui/chat/tool-cards.test.ts`.

**New tests required:** malformed/quarantined completion renders collapsed metadata only, downgraded `PASS` is not green/success, raw-open requires explicit local operator action, session history hides `subagent_announce` inter-session prompt, live stream strips runtime context, and copyable artifact ID/hash does not expose body.

### 9. Harness acceptance / finalizer / verdict handling

**Breadcrumbs mapped:** harness acceptance/finalizer/verdict handling if runtime needs harness-side gates.

**Owning module/package:** current source inspection maps this P0 path to runtime child-result, active-task, gateway agent, and protocol schema modules; no separate harness/finalizer package had to be patched for Wave 0.

**Source files and symbols:**

- `src/agents/subagent-child-result-contract.ts`: `parseChildResultReport`, `classifyChildResultContract`, `verifyExpectedArtifacts`, `scopeDisagreement`, `unverifiedScopedGateEvidence`.
- `src/agents/subagent-active-task-contract.ts`: `preflightActiveTaskExpectedOutputArtifacts`, `classifyChildCompletionAgainstActiveTask`, `validateActiveTaskContractForAcceptance`.
- `src/agents/subagent-announce.ts`: classification + delivery decision integration and `statusCard` generation.
- `src/gateway/server-methods/agent.ts`: gateway agent dispatch/idempotency/final run handling and inter-session prompt persistence controls.
- `src/gateway/protocol/schema/agent.ts`: gateway request/response protocol types for agent calls/internal events.
- Existing command harness tests: `src/commands/agent.test.ts`, `src/agents/agent-command.live-model-switch.test.ts`.

**Call chain:** child final chat/report artifact → parser/classifier → expected artifact + scope + gate process evidence checks → announce status card → gateway tracked run/final response → parent/checker/mediator decision.

**Current tests:** `src/agents/subagent-child-result-contract.test.ts`, `src/agents/subagent-active-task-contract.test.ts`, `src/gateway/protocol/schema/agent.test.ts`, `src/gateway/server-methods/agent.test.ts`, `src/commands/agent.test.ts`.

**New tests required:** schema-valid `PASS` without parent/runtime evidence fails, nonexistent/stale/out-of-scope/path-traversal artifact fails, child-fabricated checksums/logs fail, valid `FAIL` propagates, concurrent child completions cannot cross-contaminate evidence, restart/resume revalidates decisions, and finalizer/checker/mediator gates accept only `VERIFIED_PASS`.

## Unresolved mapping gaps

None for P0 raw-output-to-parent, compaction/memory/prompt-reconstruction, or acceptance paths.

Safe later-wave details that are intentionally not blockers for Wave 0:

- Exact raw-open UI affordance and authorization flow are Wave 6 design details after the metadata-only path exists.
- Historical polluted-session repair policy is Wave 4/7 rollout work after sanitizer/quarantine types exist.
- Telemetry dashboards and rollout thresholds are Wave 7, not required before Wave 1/2 coding begins.

## Implementation packet for later waves

No runtime code was changed in Wave 0. If this source map is accepted, later waves should be scoped to these source/test surfaces:

1. **Wave 1 parser/quarantine/schema:**
   - Source: `src/agents/subagent-child-result-contract.ts`, possible new `src/agents/subagent-child-result-quarantine.ts`, `src/agents/subagent-active-task-contract.ts`.
   - Tests: `src/agents/subagent-child-result-contract.test.ts`, `src/agents/subagent-active-task-contract.test.ts`, adversarial fixtures under `test/fixtures/`.
2. **Wave 2 announce fail-closed integration:**
   - Source: `src/agents/subagent-announce-output.ts`, `src/agents/subagent-announce.ts`, `src/agents/subagent-announce-delivery.ts`, `src/agents/subagent-announce-dispatch.ts`, `src/agents/internal-events.ts`, `src/agents/announce-idempotency.ts`, `src/agents/subagent-registry-completion-dedupe.ts`.
   - Tests: `src/agents/subagent-announce-output.test.ts`, `src/agents/subagent-announce.test.ts`, `src/agents/subagent-announce-delivery.test.ts`, `src/agents/subagent-announce-dispatch.test.ts`, `src/agents/internal-events.test.ts`.
3. **Wave 3 evidence verifier/gates:**
   - Source: `src/agents/subagent-child-result-contract.ts`, `src/agents/subagent-active-task-contract.ts`, `src/gateway/server-methods/agent.ts`, `src/gateway/protocol/schema/agent.ts`.
   - Tests: child-result/active-task/gateway protocol/server/command tests plus restart/resume fixtures.
4. **Wave 4 compaction/memory sanitizer:**
   - Source: `src/agents/internal-runtime-context.ts`, `src/agents/compaction.ts`, `src/agents/pi-hooks/compaction-safeguard.ts`, `src/agents/pi-hooks/compaction-safeguard-quality.ts`, `src/agents/pi-embedded-runner/compaction-successor-transcript.ts`, `packages/memory-host-sdk/src/host/session-files.ts`.
   - Tests: compaction, PI embedded runner, memory session-files fixtures.
5. **Wave 5 P0 preflight subset:**
   - Source: `src/agents/subagent-spawn.ts`, `src/agents/subagent-spawn.test-helpers.ts`, `src/agents/tools/sessions-spawn-tool.ts`, `src/agents/subagent-active-task-contract.ts`.
   - Tests: spawn/session tool/active-task preflight tests.
6. **Wave 6 UI/status:**
   - Source: `src/gateway/session-history-state.ts`, `src/gateway/chat-display-projection.ts`, `src/gateway/live-chat-projector.ts`, `ui/src/ui/chat/message-extract.ts`, `ui/src/ui/controllers/chat.ts`, `ui/src/ui/chat/build-chat-items.ts`, protocol schema.
   - Tests: gateway history/projection and UI chat/controller/tool-card tests.

## Context-preservation note

The current instruction context explicitly included exact identifiers that should not be normalized away by compaction or report writing, including `d:
`, `n:
`, `/../config/sessions/store.js`, `/../config/sessions/types.js`, `/config/types.agent-defaults.js`, and `/infra/errors.js`. They are not Wave 0 patch targets; they are preserved here only as exact-identifier examples relevant to compaction-quality regression coverage.
