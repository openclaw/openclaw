---
summary: "Which typed-public SDK subpath replaces each legacy import, including the retained channel facades"
read_when:
  - You are replacing a broad SDK barrel import with a focused subpath
  - You need the retained channel facade to channel-outbound mappings
title: "Import path reference"
sidebarTitle: "Import paths"
---

How to pick the narrowest documented subpath, and the per-export mappings for the retained channel facades. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Import path reference

Use the topical SDK guides linked from [SDK overview](/plugins/sdk-overview)
and prefer the narrowest documented typed-public subpath. In `package.json`,
these subpaths have both `types` and `default` export targets.

The compiler inventory in `scripts/lib/plugin-sdk-entrypoints.json` also contains
private-local entries. Their classification is maintained in
`scripts/lib/plugin-sdk-private-local-only-subpaths.json`. Production-private
entries may have JavaScript-only `default` exports for bundled or separately
published official plugins, but their declarations are excluded from the package.
A runtime export or a source file is not a typed third-party SDK contract.

The mappings on this page are a migration subset, not the full SDK surface.
Check both the public subpath and its actual named exports before replacing an
import.

Reserved bundled-plugin helper seams have been retired from the public SDK
export map except for explicitly documented compatibility facades such as the
deprecated `plugin-sdk/discord` shim retained for external plugins that still
import the published `@openclaw/discord` package directly. Owner-specific
helpers live inside the owning plugin package; shared host behavior moves
through generic SDK contracts such as `plugin-sdk/gateway-runtime`,
`plugin-sdk/security-runtime`, and the injected plugin API.

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask maintainers which generic
contract should own it.

### Retained channel facade mappings

The retained channel facades are not interchangeable with `channel-outbound`.
Migrate each function and type separately.

For `openclaw/plugin-sdk/channel-reply-pipeline`, use these exports from
`openclaw/plugin-sdk/channel-outbound`:

| Legacy export                                                                   | Modern export                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createChannelReplyPipeline`                                                    | `createChannelMessageReplyPipeline`            |
| `resolveChannelSourceReplyDeliveryMode`                                         | `resolveChannelMessageSourceReplyDeliveryMode` |
| `createReplyPrefixContext`, `createReplyPrefixOptions`, `createTypingCallbacks` | Same names                                     |

These functions share their implementations with the retained facade. The named
types do not all move with them: `channel-outbound` does not export
`ChannelReplyPipeline`, `CreateTypingCallbacksParams`, `ReplyPrefixContext`,
`ReplyPrefixContextBundle`, `ReplyPrefixOptions`, or `TypingCallbacks`.
`SourceReplyDeliveryMode` is available from the typed-public
`openclaw/plugin-sdk/reply-runtime` subpath. Callers that still need the other
named imports must retain their compatibility type imports until an SDK owner
approves a public replacement; do not import the internal `channel-reply-core`
source file.

From `openclaw/plugin-sdk/channel-lifecycle`, these functions move unchanged to
`channel-outbound`: `createAccountStatusSink`, `createChannelRunQueue`,
`keepHttpServerTaskAlive`, `runPassiveAccountLifecycle`, `waitUntilAbort`,
`createDraftStreamLoop`, `createFinalizableDraftLifecycle`,
`createFinalizableDraftStreamControlsForState`, and `takeMessageIdAfterStop`.
Other lifecycle helpers need more than a path change:

| Retained helper                                       | Migration limit                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliverFinalizableDraftPreview`                      | Adapt to `defineFinalizableLivePreviewAdapter` and `deliverWithFinalizableLivePreviewAdapter`. Move preview callbacks into `adapter` and handle an object result with `kind` and optional `liveState`, not the legacy string result. The adapter can return `preview-retained`; the legacy wrapper maps that kind to `normal-skipped`. |
| `createFinalizableDraftStreamControls`                | `createFinalizableDraftStreamControlsForState` requires a shared `{ stopped, final }` object instead of custom state getter/marker callbacks.                                                                                                                                                                                          |
| `clearFinalizableDraftMessage`                        | Adopting `createFinalizableDraftLifecycle` changes cleanup ownership: it serializes clears and retains failed deletions for retry. `takeMessageIdAfterStop` only takes the ID; it does not delete the message.                                                                                                                         |
| `createRunStateMachine`, `createArmableStallWatchdog` | No modern public equivalents. Keep retained imports pending an SDK-owner decision.                                                                                                                                                                                                                                                     |

The named types `ChannelRunQueue`, `ChannelRunQueueParams`,
`ChannelRunQueueTaskContext`, `DraftPreviewFinalizerDraft`,
`DraftPreviewFinalizerResult`, `DraftStreamLoop`, `FinalizableDraftStreamState`,
`ArmableStallWatchdog`, and `StallWatchdogTimeoutMeta` are not exported by
`channel-outbound`. Nor does it export `deliverFinalizableLivePreview`,
`LivePreviewFinalizerDraft`, or `LivePreviewFinalizerResult`, despite the legacy
finalizer annotations recommending them. Keep needed compatibility type imports;
inferred factory results are not necessarily identical to caller-implemented
legacy interfaces.

For `openclaw/plugin-sdk/channel-message`, move outbound exports unchanged to
`channel-outbound`, but migrate its three dispatch aliases to
`openclaw/plugin-sdk/channel-inbound`:

| Legacy export                      | Modern inbound export               |
| ---------------------------------- | ----------------------------------- |
| `hasFinalChannelTurnDispatch`      | `hasFinalInboundReplyDispatch`      |
| `hasVisibleChannelTurnDispatch`    | `hasVisibleInboundReplyDispatch`    |
| `resolveChannelTurnDispatchCounts` | `resolveInboundReplyDispatchCounts` |

These aliases share their implementations and signatures. See
[Channel outbound API](/plugins/sdk-channel-outbound) for the outbound contract.
