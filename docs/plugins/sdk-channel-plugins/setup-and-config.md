---
summary: "Setup subpaths, account schemas and inheritance, and the other narrow channel subpaths for config, inbound, targets, and threading"
read_when:
  - You are building a channel setup wizard or setup entry
  - You need account schema defaults, policy refinement, or config inheritance
  - You want the narrow channel subpaths for a hot entrypoint
title: "Channel setup and config"
sidebarTitle: "Setup and config"
---

Wire channel setup, account config schemas, and the narrow SDK subpaths that
keep entrypoints cheap to import. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Setup subpaths

- `openclaw/plugin-sdk/setup-runtime` covers the runtime-safe setup helpers:
  `createSetupTranslator`, import-safe setup patch adapters
  (`createPatchedAccountSetupAdapter`, `createEnvPatchedAccountSetupAdapter`,
  `createSetupInputPresenceValidator`), lookup-note output,
  `promptResolvedAllowFrom`, `splitSetupEntries`, and the delegated
  setup-proxy builders.
- `openclaw/plugin-sdk/channel-setup` covers the optional-install setup
  builders plus a few setup-safe primitives: `createOptionalChannelSetupSurface`,
  `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`,
  `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`,
  `setSetupChannelEnabled`, and `splitSetupEntries`.
- Use the broader `openclaw/plugin-sdk/setup` seam only when you also need
  the heavier shared setup/config helpers such as
  `moveSingleAccountChannelSectionToDefaultAccount(...)`.

If your channel only wants to advertise "install this plugin first" in setup
surfaces, prefer `createOptionalChannelSetupSurface(...)`. The generated
adapter/wizard fail closed on config writes and finalization, and they reuse
the same install-required message across validation, finalize, and docs-link
copy.

If your channel supports env-driven setup or auth, expose it through the
channel config schema and setup descriptors. Keep channel runtime `envVars` or
local constants for operator-facing copy only.

If your channel can appear in `status`, `channels list`, `channels status`, or
SecretRef scans before the plugin runtime starts, add `openclaw.setupEntry` in
`package.json`. That entrypoint should be safe to import in read-only command
paths and should return the channel metadata, setup-safe config adapter,
status adapter, and channel secret target metadata needed for those
summaries. Do not start clients, listeners, or transport runtimes from the
setup entry.

Keep the main channel entry import path narrow too. Discovery can evaluate
the entry and the channel plugin module to register capabilities without
activating the channel. Files such as `channel-plugin-api.ts` should export
the channel plugin object without importing setup wizards, transport
clients, socket listeners, subprocess launchers, or service startup modules.
Put those runtime pieces in modules loaded from `registerFull(...)`, runtime
setters, or lazy capability adapters.

## Account schemas and inheritance

Use `buildChannelAccountSchemaParts` from
`openclaw/plugin-sdk/channel-config-schema`. Its `accountShape` leaves
`dmPolicy` and `groupPolicy` optional, so an omitted account policy inherits
the channel root. Spread its `rootPolicyShape` into the root schema
only: it defaults DMs to `pairing` and groups to `allowlist`. Do not apply
those defaults to account entries or remove them from the root; the former
shadows operator settings and the latter can leave group access open.
This replaces `buildCommonChannelAccountShape` and its defaulting flags.

Use `refineChannelDmPolicy({ channelId, value, ctx })` from the same subpath
to validate the root policy against `allowFrom`. Pass `accountId` to validate
one account with root-policy and allowlist inheritance, including explicit
empty-array overrides. The helper emits the standard root/account error paths
and messages for `open` and `allowlist` policies. Keep account iteration,
disabled-account filtering, and ordering relative to other refinements in the
channel, since those rules differ between plugins.

Use `mergeAccountConfig` or `resolveMergedAccountConfig` through the existing
`openclaw/plugin-sdk/account-helpers` export for runtime inheritance. Their
shared implementation lives at `src/config/channel-account-config.ts`;
plugins must use the SDK import. Account fields replace root fields, including
explicit empty collections. `nestedObjectKeys` selects shallow object merges;
`inheritEmptyKeys` maps fields to `"array"` or `"object"` to inherit the root
when that kind of account collection is empty. `preserveRootAllowFrom: true` removes an account wildcard
when the root contains restrictive sender entries, retaining explicit account
senders or falling back to the root list. These collection and allowlist rules
are owner-selected, not universal channel defaults. Keep credentials, transport
selection, and other channel-specific account concerns in the plugin.

### Stored account-key selection

Import `resolveAccountKey`, `resolveNormalizedAccountEntry`, and
`ChannelAccountKeyPolicy` from `openclaw/plugin-sdk/account-resolution`.
Use the selected stored key for writes so an edit preserves the operator's key
spelling and updates the same entry that readers use.

For registered channel callbacks, use
`resolveAccountKey(accounts, accountId, undefined, undefined, { channelId })` to consume the selected
manifest policy from the owning operation or Gateway snapshot. Keep that metadata
scope active through reads, setup, and deletion. Do not import a second policy
from the runtime plugin's manifest: another manifest may own the channel policy.

`resolveAccountKey(accounts, accountId, normalizeAccountId?, policy?, options?)` returns a
stored key or `undefined`:

| Argument               | Meaning                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accounts`             | Authored account map, or `undefined`.                                                                                                                                                                                                |
| `accountId`            | Requested account id. With a policy, routing normalization runs first and the exact canonical key wins. Without a policy, the exact requested key wins.                                                                              |
| `normalizeAccountId`   | Optional function applied to the requested id and stored keys when no policy is supplied. Omit both for case-insensitive lookup. A policy selects routing normalization.                                                             |
| `policy`               | Optional `ChannelAccountKeyPolicy` with `canonicalAliasesRequireOwnField`, the account field that must contain its own nonempty string before a canonical-only alias is eligible. Existing case-insensitive matches remain eligible. |
| `options.channelId`    | Optional channel whose selected manifest supplies the policy. An explicit `policy` takes precedence. Without a channel or selected policy, the normalizer and case-insensitive behavior stay unchanged.                              |
| `options.allowMissing` | Return the creation target when no stored key is eligible. Reserved object keys throw before a writer can create an unreadable account.                                                                                              |

The shipped v2026.9.4 SDK does not export `resolveAccountKey`; use these options
only with a host SDK that supplies this selector and channel context. This does
not change the behavior of the older entry-returning helpers.

`resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId, policy?)`
takes the same arguments, requires the normalizer, and returns the selected entry
instead of its key. An unmatched or ineligible alias returns `undefined`; normal
channel inheritance can then apply.

`resolveMergedAccountConfig` takes `channelConfig` (root defaults), `accounts`
(the authored map), and `accountId`, plus optional `normalizeAccountId`,
`channelId`, and `accountKeyPolicy`. `channelId` selects the rule from the current
operation's prepared plugin metadata snapshot, or the published Gateway snapshot.
`accountKeyPolicy` remains available for callers with an explicitly supplied
policy. It works without `channelId` or `normalizeAccountId` and takes precedence
over the snapshot rule. Account-key selection precedes the existing field merge and
collection inheritance rules.

The setup and config adapter factories accept the same optional `accountKeyPolicy`.
Registered adapters use the prepared channel policy. The scoped setup,
account-name, enable, delete, and field-clear helpers
also accept `accountKeyPolicy`; their `accountId` is the normalized routing ID,
not a stored spelling. The registered adapters normalize operator input before
calling these helpers. `clearAccountEntryFields` additionally accepts `channelId`
to select prepared metadata, or an explicit policy without `channelId`.

Declare the rule in
[`channelAccountKeyPolicies`](/plugins/manifest/surfaces#channelaccountkeypolicies-reference)
so generic channel readers and writers receive the same policy. Deletion reruns
the selector on the proposed remaining map and refuses a deletion that would
activate a colliding row. Creation with `allowMissing: true` rejects reserved
object keys instead of writing an account that readers cannot select.

## Other narrow channel subpaths

For other hot channel paths, prefer the narrow helpers over broader legacy
surfaces:

- `openclaw/plugin-sdk/account-core`, `openclaw/plugin-sdk/account-id`,
  `openclaw/plugin-sdk/account-resolution`, and
  `openclaw/plugin-sdk/account-helpers` for multi-account config and
  default-account fallback
- `openclaw/plugin-sdk/inbound-envelope` and
  `openclaw/plugin-sdk/channel-inbound` for inbound route/envelope and
  record-and-dispatch wiring
- `readAgentRunTerminalOutcome(dispatchResult)` from
  `openclaw/plugin-sdk/channel-inbound` when terminal reactions or status UI
  must distinguish a completed core agent run from a recovered failed run. It
  returns `"completed"` or `"failed"` only when a core run actually started,
  and `undefined` for commands, dedupe, busy, pre-run abort, and custom dispatch
  results. Delivery counts and visibility remain transport facts, including
  successful delivery of an error payload; the process-local carrier is not
  serialized to JSON.
- `createInboundEventDeliveryCorrelation(...)` from
  `openclaw/plugin-sdk/inbound-event-delivery` when successful outbound sends must
  retire an active inbound-event marker; create one tracker per channel and
  keep target matching in the channel plugin
- `openclaw/plugin-sdk/channel-targets` for target parsing helpers
- `openclaw/plugin-sdk/channel-outbound` for outbound identity/send delegates
  and typed payload planning
- `buildThreadAwareOutboundSessionRoute(...)` from
  `openclaw/plugin-sdk/channel-core` when an outbound route should preserve
  an explicit `replyToId`/`threadId` or recover the current `:thread:`
  session after the base session key still matches. Provider plugins can
  override precedence, suffix behavior, and thread id normalization when
  their platform has native thread delivery semantics.
- `openclaw/plugin-sdk/thread-bindings-runtime` for thread-binding lifecycle
  and adapter registration

The `threading.resolveReplyTransport` hook receives the payload's optional
`replyToCurrent` intent separately from `replyToIsExplicit`. Channels whose
native API requires a thread root can resolve a current-message reply against
the admitted thread without redirecting arbitrary explicit `replyToId` targets.
Omitted intent keeps the existing explicit-target behavior.

For queued replies to the originating channel, the hook may also receive
`currentMessageId`, the external inbound message ID captured by the queue owner.
It is optional context, not an explicit reply target: core does not attach it as
`replyToId`. The channel decides whether to use it for implicit correlation,
while preserving explicit targets, null opt-outs, and reply-mode filtering.
Internal and inter-session turns do not supply this external message fact.

Auth-only channels can usually stop at the default path: core handles
approvals and the plugin just exposes outbound/auth capabilities. Native
approval channels such as Matrix, Slack, Telegram, and custom chat transports
should use the shared native helpers instead of rolling their own approval
lifecycle.
