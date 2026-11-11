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

Reserved bundled-plugin helper interfaces, including the `plugin-sdk/discord` and
`plugin-sdk/telegram-account` compatibility facades, have been retired from the
public SDK export map. Owner-specific
helpers live inside the owning plugin package; shared host behavior moves
through generic SDK contracts such as `plugin-sdk/gateway-runtime`,
`plugin-sdk/security-runtime`, and the injected plugin API.

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask maintainers which generic
contract should own it.

### Removed command and channel facades

The `command-auth`, `discord`, and `telegram-account` subpaths were retired on
October 2, 2026 with explicit SDK-owner approval. Use these replacements:

| Removed surface                                                                         | Replacement                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command-auth` sender authorization helpers and runtime parameter types                 | `resolveChannelMessageIngress` from `channel-ingress-runtime`; adapt the caller to the ingress contract rather than recreating legacy allowlist policy. |
| `command-auth` native command parsing, specs, authorization, and session-target helpers | The matching named exports from `command-auth-native`.                                                                                                  |
| `command-auth` help builders                                                            | `buildCommandsMessage`, `buildCommandsMessagePaginated`, and `buildHelpMessage` from `command-status`.                                                  |
| `command-auth` model-provider data helpers                                              | The matching named exports from `models-provider-runtime`.                                                                                              |
| `command-auth` access-group helpers                                                     | Delegate sender authorization to `channel-ingress-runtime`; `access-groups` is private-local and is not a third-party replacement.                      |
| `command-auth` direct-DM access helpers                                                 | The matching named exports from `channel-inbound`.                                                                                                      |
| `discord` generic channel types and helpers                                             | The matching named exports from `channel-contract`, `channel-core`, `channel-plugin-common`, `channel-status`, or `config-contracts`.                   |
| `discord` channel-owned helpers and types                                               | Repository consumers use the Discord plugin's `api.ts` / `runtime-api.ts`; external plugins use generic channel contracts and the injected runtime.     |
| `telegram-account` account resolution and types                                         | Repository consumers use the Telegram plugin's `api.ts`; external plugins use generic channel contracts and injected runtime helpers.                   |

Check each named export before changing an import. The legacy sender-authorization
types and Discord facade's permissive component/thread-binding types are removed;
the owning APIs have their own contracts. Some legacy exports have no typed-public
replacement and require caller changes. Do not replace them with private-local
host exports or another plugin's private `src/*` files. Older published packages
that import these facades must be upgraded before loading them on a host containing
this removal; SDK-owner approval is not evidence of external migration.

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
