---
summary: "Which typed-public SDK subpath replaces each legacy import, including the removed channel facades"
read_when:
  - You are replacing a broad SDK barrel import with a focused subpath
  - You need the removed channel facade to channel-outbound mappings
title: "Import path reference"
sidebarTitle: "Import paths"
---

How to pick the narrowest documented subpath, and the per-export mappings for the removed channel facades. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

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

<a id="retained-channel-facade-mappings" />

### Removed channel facade mappings

The removed channel facades are not interchangeable with `channel-outbound`.
Migrate each function and type separately.

For `openclaw/plugin-sdk/channel-reply-pipeline`, use these exports from
`openclaw/plugin-sdk/channel-outbound`:

| Legacy export                                                                   | Modern export                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createChannelReplyPipeline`                                                    | `createChannelMessageReplyPipeline`            |
| `resolveChannelSourceReplyDeliveryMode`                                         | `resolveChannelMessageSourceReplyDeliveryMode` |
| `createReplyPrefixContext`, `createReplyPrefixOptions`, `createTypingCallbacks` | Same names                                     |

These functions preserve the former facade's implementations. Their named
types are also available unchanged from `channel-outbound`:
`ChannelReplyPipeline`, `CreateTypingCallbacksParams`, `ReplyPrefixContext`,
`ReplyPrefixContextBundle`, `ReplyPrefixOptions`, `SourceReplyDeliveryMode`,
and `TypingCallbacks`.

From `openclaw/plugin-sdk/channel-lifecycle`, these functions move unchanged to
`channel-outbound`: `createAccountStatusSink`, `createChannelRunQueue`,
`keepHttpServerTaskAlive`, `runPassiveAccountLifecycle`, `waitUntilAbort`,
`createDraftStreamLoop`, `createFinalizableDraftLifecycle`,
`createFinalizableDraftStreamControls`,
`createFinalizableDraftStreamControlsForState`, `clearFinalizableDraftMessage`,
`takeMessageIdAfterStop`, `createRunStateMachine`, and `createArmableStallWatchdog`.

The named types `ChannelRunQueue`, `ChannelRunQueueParams`,
`ChannelRunQueueTaskContext`, `DraftStreamLoop`, `FinalizableDraftStreamState`,
`ArmableStallWatchdog`, and `StallWatchdogTimeoutMeta` also move unchanged to
`channel-outbound`.

Replace `deliverFinalizableDraftPreview` with
`defineFinalizableLivePreviewAdapter` and `deliverWithFinalizableLivePreviewAdapter`.
Move preview callbacks into `adapter` and handle an object result with `kind`
and optional `liveState`, not the legacy string result. The adapter can return
`preview-retained`; the removed wrapper mapped that kind to `normal-skipped`.

The legacy `DraftPreviewFinalizerDraft` and `DraftPreviewFinalizerResult` names
are removed. Adapt type usage to the focused live-preview contracts and account
for the result-shape change.

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
