---
summary: "Step-by-step guide to building a messaging channel plugin for OpenClaw"
title: "Building channel plugins"
sidebarTitle: "Channel Plugins"
read_when:
  - You are building a new messaging channel plugin
  - You want to connect OpenClaw to a messaging platform
  - You need to understand the ChannelPlugin adapter surface
---

This guide builds a channel plugin that connects OpenClaw to a messaging
platform: DM security, pairing, reply threading, and outbound messaging.

<Info>
  New to OpenClaw plugins? Read [Getting Started](/plugins/building-plugins)
  first for package structure and manifest setup.
</Info>

## What your plugin owns

Channel plugins do not implement send/edit/react tools; core provides one
shared `message` tool. Your plugin owns:

- **Config** - account resolution and setup wizard
- **Security** - DM policy and allowlists
- **Pairing** - DM approval flow
- **Session grammar** - how provider-specific conversation ids map to base
  chats, thread ids, and parent fallbacks
- **Outbound** - sending text, media, and polls to the platform
- **Threading** - how replies are threaded
- **Heartbeat typing** - optional typing/busy signals for heartbeat delivery
  targets

Core owns the shared message tool, prompt wiring, the outer session-key shape,
generic `:thread:` bookkeeping, and dispatch. For configured agent group
threads, core also owns participant selection, follow-up rounds, and turn
budgets. Keep those policies out of channel adapters.

Core also owns model-picker product actions. A channel that renders a
`ModelPickerAction` declares its `ModelPickerCapabilityProfile`, then encodes
the typed action in a transport-private authenticated callback envelope. Keep
approval, command, URL, web-app, question, callback, and model-picker actions
distinguishable until that encoding boundary; never infer picker intent from a
raw callback string. Actor and source-message checks remain channel-owned.

## Walkthrough

<Steps>
  <a id="step-1-package-and-manifest"></a>
  <Step title="Package and manifest">
    Create the standard plugin files. The `channels` field in
    `openclaw.plugin.json` (not a `kind` field) is what marks a manifest as
    owning a channel. For the full package-metadata surface, see
    [Plugin Setup and Config](/plugins/sdk-setup#openclaw-channel):

    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-chat",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "acme-chat",
          "label": "Acme Chat",
          "blurb": "Connect OpenClaw to Acme Chat."
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-chat",
      "channels": ["acme-chat"],
      "name": "Acme Chat",
      "description": "Acme Chat channel plugin",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "channelConfigs": {
        "acme-chat": {
          "schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "token": { "type": "string" },
              "allowFrom": {
                "type": "array",
                "items": { "type": "string" }
              }
            }
          },
          "uiHints": {
            "token": {
              "label": "Bot token",
              "sensitive": true
            }
          }
        }
      }
    }
    ```
    </CodeGroup>

    `configSchema` validates `plugins.entries.acme-chat.config`. Use it for
    plugin-owned settings that are not the channel account config.
    `channelConfigs.acme-chat.schema` validates `channels.acme-chat` and is the
    cold-path source used by config schema, setup, and UI surfaces before the
    plugin runtime loads. See [Plugin manifest](/plugins/manifest) for the full
    top-level field reference.

  </Step>

  <Step title="Build the channel plugin object">
    The `ChannelPlugin` interface has many optional adapter surfaces. Start with
    the minimum - `id`, `config`, and `setup` - and add adapters as you need
    them. `createChatChannelPlugin` defaults omitted capabilities to direct
    messages; declare `capabilities.chatTypes` when the channel supports more.

    `config.inspectAccount` is synchronous and returns metadata
    for read-only diagnostics, including disabled or configured-but-unavailable
    accounts. Return `enabled`, `configured`, and applicable credential status
    fields without requiring secret resolution. Its result is not a resolved
    account: operational hooks such as probes and account status builders receive
    `config.resolveAccount` results instead.
    Diagnostics expose only status-safe fields from the inspection result.
    Include the same account enablement and configuration decisions used by the
    runtime, including duplicate-account suppression. If `configured` is omitted,
    diagnostics use a recorded Gateway value when available; otherwise they report
    that configuration status is unavailable.
    Selection before secret redemption also reads this metadata directly. Directory
    auto-selection requires `configured: true`; callers can still select the channel
    explicitly when configuration status is unknown.

    Create `src/channel.ts`:

    ```typescript src/channel.ts
    import {
      createChatChannelPlugin,
      createChannelPluginBase,
    } from "openclaw/plugin-sdk/channel-core";
    import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatApi } from "./client.js"; // your platform API client

    type ResolvedAccount = {
      accountId: string | null;
      token: string;
      allowFrom: string[];
      dmPolicy: string | undefined;
    };

    function resolveAccount(
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedAccount {
      const section = (cfg.channels as Record<string, any>)?.["acme-chat"];
      const token = section?.token;
      if (!token) throw new Error("acme-chat: token is required");
      return {
        accountId: accountId ?? null,
        token,
        allowFrom: section?.allowFrom ?? [],
        dmPolicy: section?.dmSecurity,
      };
    }

    export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
      base: createChannelPluginBase({
        id: "acme-chat",
        // Account resolution/inspection belongs on `config`, not `setup`.
        // `setup` covers onboarding writes (applyAccountConfig, validateInput).
        config: {
          listAccountIds: () => ["default"],
          resolveAccount,
          inspectAccount(cfg, accountId) {
            const section =
              (cfg.channels as Record<string, any>)?.["acme-chat"];
            return {
              enabled: Boolean(section?.token),
              configured: Boolean(section?.token),
              tokenStatus: section?.token ? "available" : "missing",
            };
          },
        },
        setup: {
          applyAccountConfig: ({ cfg, input }) => ({
            ...cfg,
            channels: {
              ...cfg.channels,
              "acme-chat": { ...(cfg.channels as any)?.["acme-chat"], ...input },
            },
          }),
        },
      }),

      // DM security: who can message the bot
      security: {
        dm: {
          channelKey: "acme-chat",
          resolvePolicy: (account) => account.dmPolicy,
          resolveAllowFrom: (account) => account.allowFrom,
          defaultPolicy: "allowlist",
        },
      },

      // Pairing: approval flow for new DM contacts
      pairing: {
        text: {
          idLabel: "Acme Chat username",
          message: "Send this code to verify your identity:",
          notify: async ({ target, code }) => {
            await acmeChatApi.sendDm(target, `Pairing code: ${code}`);
          },
        },
      },

      // Threading: how replies are delivered
      threading: { topLevelReplyToMode: "reply" },

      // Outbound: send messages to the platform
      outbound: {
        attachedResults: {
          channel: "acme-chat",
          sendText: async (params) => {
            const result = await acmeChatApi.sendMessage(
              params.to,
              params.text,
            );
            return { messageId: result.id };
          },
        },
        base: {
          sendMedia: async (params) => {
            await acmeChatApi.sendFile(params.to, params.filePath);
          },
        },
      },
    });
    ```

    For channels that accept both canonical top-level DM keys and legacy nested keys, use the helpers from `plugin-sdk/channel-config-helpers`: `resolveChannelDmAccess`, `resolveChannelDmPolicy`, `resolveChannelDmAllowFrom`, and `normalizeChannelDmPolicy` keep account-local values ahead of inherited root values. Pair the same resolver with doctor repair through `normalizeLegacyDmAliases` so runtime and migration read the same contract.

    Config-backed logout handlers can use `clearAccountFieldsFromConfigSection`
    from `openclaw/plugin-sdk/channel-config-helpers`. Pass `cfg`, `sectionKey`,
    `accountId`, and the plugin-owned `fields` to remove. It returns
    `{ nextConfig, changed, cleared }` without writing config or resolving
    credentials. Root fields clear together only for the exact `default` account
    when at least one value is truthy. Nested fields use `clearAccountEntryFields`
    semantics: an empty account ID selects `accounts.default`, and empty or
    whitespace strings are removed without reporting `cleared` unless
    `markClearedOnFieldPresence: true` is set. Unchanged config retains its object
    identity; cleanup prunes only branches it changes. Keep file-reference
    selection, persistence, environment reporting, and other logout side effects
    in the plugin.

    If a channel intentionally applies stricter DM session routing than the
    global config, expose that behavior through `security.dmRouting` so Doctor
    and security audit resolve the same session owner as runtime. The optional
    `resolveDmScope` callback runs before core route resolution; its context
    includes `cfg`, `accountId`, the resolved `account`, and a `principalId`
    for finite allowlist entries. `resolveDmRoute` receives those fields plus
    the resolved core `route`; it may return `{ sessionKey }` for a shared final
    bucket, `{ kind: "isolated" }` for an unknown peer, or `{ kind: "core" }`
    to preserve core `dmScope` namespace analysis. For wildcard/open policy,
    `principalId` is absent and an undefined result is reported as unverified.
    Diagnostics never invent a peer ID. Keep both callbacks pure and
    import-safe because read-only diagnostics run without channel runtime.

    Channel-specific security diagnostics can use `security.collectWarnings`.
    Legacy string results are warning severity. Return the structured
    `SecurityAuditFinding` shape (`checkId`, `severity`, `title`, `detail`, and
    optional `remediation`) when the producer must declare informational or
    critical severity; the same finding is used by Doctor and the main security
    audit. Use `collectAuditFindings` only for diagnostics that should appear in
    the full security audit but not Doctor.

    <Accordion title="What createChatChannelPlugin does for you">
      Instead of implementing low-level adapter interfaces manually, you pass
      declarative options and the builder composes them:

      | Option | What it wires |
      | --- | --- |
      | `security.dm` | Scoped DM security resolver from config fields |
      | `pairing.text` | Text-based DM pairing flow with code exchange |
      | `threading` | Reply-to-mode resolver (fixed, account-scoped, or custom) |
      | `outbound.attachedResults` | Send functions that return result metadata (message IDs); requires a sibling `channel` id so core can stamp the returned delivery result |

      You can also pass raw adapter objects instead of the declarative options
      if you need full control.

      Raw outbound adapters may define a `chunker(text, limit, ctx)` function.
      The optional `ctx.formatting` carries delivery-time formatting decisions
      such as `maxLinesPerMessage`; apply it before sending so reply threading
      and chunk boundaries are resolved once by shared outbound delivery.
      Send contexts also include `replyToIdSource` (`implicit` or `explicit`)
      when a native reply target was resolved, so payload helpers can preserve
      explicit reply tags without consuming an implicit single-use reply slot.
    </Accordion>

    ### Group tool-policy adapters

    A channel that implements `group.resolveToolPolicy` and supports
    `toolsBySender` must forward the complete `ChannelGroupContext` to its
    shared policy resolver. In particular, honor `senderPolicyMode: "never"`
    by skipping sender-specific overlays at both the matched-group and wildcard
    scopes while still applying the base `tools` policy.

    OpenClaw sets this mode only for trusted non-ingress execution whose sender
    authority was already captured in a server-owned envelope, such as an
    explicitly capped scheduled run. Plugins must not derive the mode from
    inbound metadata, persist it as channel state, or expose it as config. Add
    an adapter test that proves the mode skips a wildcard `toolsBySender` entry
    without dropping the matching base `tools` restriction.

    ### Native plugin command ownership

    Channel plugins that publish provider-native command catalogs should use
    `openclaw/plugin-sdk/plugin-command-runtime`. Create one runtime while
    planning the catalog, merge its candidates with built-in and skill entries,
    and retain the winning candidate object in the registered handler closure.
    A plugin registry replacement drains and restarts loaded channel accounts
    so their handlers, command catalogs, and routes use the new generation.
    Manually stopped accounts stay stopped. Ordinary channel config changes
    still restart only the affected channel or accounts.
    `retainNativeCatalog(provider)` has been deprecated since 2026.9.2 and
    will be removed in the next breaking SDK release; it is retained for
    callers written against 2026.9.1, and existing calls only assert that the
    captured registry generation is still active.
    Call `prepareDispatch(rawArgs)` only on that winner and execute the returned
    dispatch with `dispatch.execute(context)`. Carry an explicit
    `{ kind: "non-plugin" }` decision for retained built-in and skill winners.
    This keeps the advertised command and
    its executable plugin registration on the same registry generation.

    Candidates expose only immutable display/auth/progress metadata plus an
    opaque process-local dispatch. They do not expose handlers, plugin roots,
    or registry rows. Dispatches cannot cross runtime factories or channels,
    and a registry replacement makes new executions return an unavailable
    result instead of rematching command text against the replacement registry.
    A command already admitted before retirement may finish on its captured
    generation. Do not serialize candidates or dispatches; project only their
    display fields into provider API payloads.

  </Step>

  <Step title="Wire the entry point">
    Create `index.ts`:

    ```typescript index.ts
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineChannelPluginEntry({
      id: "acme-chat",
      name: "Acme Chat",
      description: "Acme Chat channel plugin",
      plugin: acmeChatPlugin,
      registerCliMetadata(api) {
        api.registerCli(
          ({ program }) => {
            program
              .command("acme-chat")
              .description("Acme Chat management");
          },
          {
            descriptors: [
              {
                name: "acme-chat",
                description: "Acme Chat management",
                hasSubcommands: false,
              },
            ],
          },
        );
      },
      registerFull(api) {
        api.registerGatewayMethod(/* ... */);
      },
    });
    ```

    Put channel-owned CLI descriptors in `registerCliMetadata(...)` so OpenClaw
    can show them in root help without activating the full channel runtime,
    while normal full loads still pick up the same descriptors for real command
    registration. Keep `registerFull(...)` for runtime-only work.
    `defineChannelPluginEntry` handles the registration-mode split automatically.
    If `registerFull(...)` registers gateway RPC methods, use a
    plugin-specific prefix. Core admin namespaces (`config.*`,
    `exec.approvals.*`, `wizard.*`, `update.*`) stay reserved and always
    resolve to `operator.admin`. See
    [Entry Points](/plugins/sdk-entrypoints#definechannelpluginentry) for all
    options.

  </Step>

  <Step title="Add a setup entry">
    Create `setup-entry.ts` for lightweight loading during onboarding:

    ```typescript setup-entry.ts
    import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineSetupPluginEntry(acmeChatPlugin);
    ```

    OpenClaw loads this instead of the full entry when the channel is disabled
    or unconfigured. It avoids pulling in heavy runtime code during setup flows.
    See [Setup and Config](/plugins/sdk-setup#setup-entry) for details.

    Bundled workspace channels that split setup-safe exports into sidecar
    modules can use `defineBundledChannelSetupEntry(...)` from
    `openclaw/plugin-sdk/channel-entry-contract` when they also need an
    explicit setup-time runtime setter.

  </Step>

  <Step title="Handle inbound messages">
    Your plugin needs to receive messages from the platform and forward them to
    OpenClaw. The typical pattern is a webhook that verifies the request and
    dispatches it through your channel's inbound handler:

    ```typescript
    registerFull(api) {
      api.registerHttpRoute({
        path: "/acme-chat/webhook",
        auth: "plugin", // plugin-managed auth (verify signatures yourself)
        handler: async (req, res) => {
          const event = parseWebhookPayload(req);

          // Your inbound handler dispatches the message to OpenClaw.
          // The exact wiring depends on your platform SDK -
          // see a real example in the bundled Microsoft Teams or Google Chat plugin package.
          await handleAcmeChatInbound(api, event);

          res.statusCode = 200;
          res.end("ok");
          return true;
        },
      });
    }
    ```

    <Note>
      Inbound message handling is channel-specific. Each channel plugin owns
      its own inbound pipeline. Look at bundled channel plugins
      (for example the Microsoft Teams or Google Chat plugin package) for real patterns.
    </Note>

    Routes registered with `auth: "gateway"` use the Gateway's credential
    checks. Before a handler performs a mutation or starts other side effects,
    finish reading and validating its body and waiting for queued work, then call
    `await getPluginRuntimeGatewayRequestScope()?.revalidate?.()` from
    `openclaw/plugin-sdk/plugin-runtime`. The request-scoped capability rechecks
    an admitted device credential and its original scopes through the Gateway
    auth owner. It writes the standard HTTP 401 error and throws if the grant
    was revoked, rotated, or narrowed. Let the rejection stop the handler; an
    error handler must not replace an already-ended response. The capability
    expires with the HTTP response and is absent for other authentication paths.

    This check authorizes the work about to start. It does not cancel an
    external operation already in progress. Revalidate again before later
    independent mutations, such as saving a published or imported profile after
    relay I/O.

  </Step>

<a id="step-6-test"></a>
<Step title="Test">
Write colocated tests in `src/channel.test.ts`:

    ```typescript src/channel.test.ts
    import { describe, it, expect } from "vitest";
    import { acmeChatPlugin } from "./channel.js";

    describe("acme-chat plugin", () => {
      it("resolves account from config", () => {
        const cfg = {
          channels: {
            "acme-chat": { token: "test-token", allowFrom: ["user1"] },
          },
        } as any;
        const account = acmeChatPlugin.config.resolveAccount(cfg, undefined);
        expect(account.token).toBe("test-token");
      });

      it("inspects account without materializing secrets", () => {
        const cfg = {
          channels: { "acme-chat": { token: "test-token" } },
        } as any;
        const result = acmeChatPlugin.config.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(true);
        expect(result.tokenStatus).toBe("available");
      });

      it("reports missing config", () => {
        const cfg = { channels: {} } as any;
        const result = acmeChatPlugin.config.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(false);
      });
    });
    ```

    ```bash
    pnpm test <bundled-plugin-root>/acme-chat/
    ```

    For shared test helpers, see [Testing](/plugins/sdk-testing).

</Step>
</Steps>

## File structure

```text
<bundled-plugin-root>/acme-chat/
├── package.json              # openclaw.channel metadata
├── openclaw.plugin.json      # Manifest with config schema
├── index.ts                  # defineChannelPluginEntry
├── setup-entry.ts            # defineSetupPluginEntry
├── api.ts                    # Public exports (optional)
├── runtime-api.ts            # Internal runtime exports (optional)
└── src/
    ├── channel.ts            # ChannelPlugin via createChatChannelPlugin
    ├── channel.test.ts       # Tests
    ├── client.ts             # Platform API client
    └── runtime.ts            # Runtime store (if needed)
```

## Delegated context reads

Bundled actions can prove equivalence between provider-native delivery aliases and
the current conversation with
`actions.messageActionTargetAliases[action].matchesCurrentConversationAsync`.
The callback receives `{ args, accountId, toolContext }` and returns
`Promise<boolean>`. The host awaits it only after checking the current provider,
account, and any additional requested targets. External registrations cannot use
this callback to bypass exact-current matching. A successful async match does not
replace live caller or registration authority; the host rechecks those before
dispatch.

Async alias proof requires the selected bundled registration to be loaded.
Liveness checks use its captured owner authority and the loaded registry; they
never discover or load a bundled fallback after the registration is retired.
Normal bundled runtime registration satisfies this requirement. The retained
synchronous path keeps its existing compatibility behavior.

The async callback takes precedence over `matchesCurrentConversation` when both
are present. A false result or rejected promise never falls back to the legacy
callback. The synchronous callback is deprecated for storage-backed matching but
remains supported for older plugins and hosts, with no removal version scheduled.
Keep its return type strictly `boolean`: older hosts treat a returned promise as
truthy rather than awaiting it. Hosts predating the async companion ignore the new
field and use only the synchronous callback. An async-only alias therefore cannot
prove equivalence on those hosts; exact canonical target matching still works.

Verified official installed plugins can delegate supported conversation, metadata, and attachment
reads to provider-owned access checks. Channel-origin requests need server-owned
current provider, account, and conversation context. An authenticated dashboard user
turn can also use those provider-owned checks without native channel context, including
Incognito sessions and fresh messages after reconnect. Ordinary transport loss does not
cancel an already admitted turn. This permission belongs only to that turn; background
work and scheduled jobs keep their separate authorization.
Normal chat, session participation, and tool permissions, along with provider account,
destination, action, and requester policies, remain in force.

Account-created scheduled reads use the live job's recorded creator account and origin.
An external creator origin restricts reads to that provider; a missing or unknown origin
cannot authorize a read. Omitting `accountId` selects the recorded creator account,
including after the provider's default account changes. Provider destination and action
policies remain in force. See [Scheduled tool policy](/automation/cron-jobs/payloads#agent-turn-options)
for reauthorization and execution rules.

An adapter lists actions that support the lifetime fence in `actions.readAuthorityActions`.
Its `actions.providerOwnedReadGates` declaration separately identifies the actions
whose admission the provider owns. The host also classifies the action as eligible;
a later host addition does not opt existing adapters into it.
Only host-verified official registrations qualify. Discord supports `read`, `search`,
`reactions`, `list-pins`, `thread-list`, `channel-info`, `permissions`, `member-info`,
`role-info`, `emoji-list`, `channel-list`, `voice-status`, and `event-list`.
Feishu supports `read`, `reactions`, `list-pins`, `member-info`, `channel-info`,
`channel-list`, and configured `sticker-search`.
Matrix supports `read`, `reactions`, `list-pins`, `emoji-list`, `member-info`, and
`channel-info`.
Mattermost supports `read`.
Slack supports `read`, `reactions`, `list-pins`, `member-info`, `emoji-list`, and
`download-file`.
Older external adapters and unverified plugins retain the exact-current-conversation
restriction. These declarations apply only to the listed read actions.

Delegated Slack member info is limited to the current requester on the same account,
and emoji discovery uses the trusted workspace. Neither metadata action requires
a channel target.

Microsoft Teams supports `read`, `search`, `reactions`, `list-pins`, `member-info`,
`channel-info`, and `channel-list` under the [Teams access rules](/channels/msteams/access-control).

Discord's `permissions` action inspects the bot's permissions for an allowed channel.
Guild metadata reads require the requested guild to be allowed by the selected
account's current configuration, with unrestricted or wildcard channel access.
Only direct operators receive the filtered-results relaxation for `channel-list`;
delegated agents still require guild-wide channel access.

The transport contract is mandatory for opt-in adapters:

- Capture `captureChannelReadAuthority()` from `openclaw/plugin-sdk/fetch-runtime`
  when submitting each request, before handing it to a shared queue.
- Retain that exact callback through waits and retries; invoke it immediately
  before every provider request, including target lookup requests, after any
  asynchronous DNS or dispatcher preparation.
- An absent callback means this invocation has no additional read-authority
  fence. A thrown error stops the request; do not retry with a new callback.

The host binds the callback to the selected registration and its active lifecycle.
Local message tools and Gateway agent requests retain the originating run and
turn authority. Opted-in bundled reads use the same lifetime fence while keeping
their existing provider-owned admission rules. A bundled artifact or an omitted
scoped registration cannot supply that authority; delegated execution requires
the active registered instance. The host rejects stale
action results and errors after either caller or plugin authority is revoked.
A completed action also closes its captured callbacks. The fence prevents
subsequent requests; it cannot undo a request already sent to the provider. No
configuration switch or plugin-supplied trust field can mint this authority.

Slack attachment downloads retain the originating read authority through URL
refresh, binary transfer, media-store publication, image processing, and final
host completion. The existing media artifact is kept only when the read succeeds.
If completion is rejected, cleanup removes only files created by that operation;
preexisting files, replacements, and shared files are preserved. The source abort
signal also reaches the binary transfer where the caller supplies one.

## Scheduled channel administration

`ChannelMessageActionAdapter` exposes the optional
`writeAuthorityActions?: readonly ChannelMessageActionName[]` declaration through
`openclaw/plugin-sdk/channel-contract`. It identifies write actions whose transport
preserves the host's live request authority. Advertising an action through
`describeMessageTool` or declaring read support does not establish that contract.

The host separately selects eligible actions and requires an active bundled or
loader-verified official registration. A bundled artifact fallback or a plugin's
own trust claim cannot supply registration authority. Discord declares
`writeAuthorityActions: ["channel-edit", "delete", "edit", "pin", "unpin"]`.
Other action names do not gain scheduled access from this declaration.

Scheduled `channel-edit`, including its existing channel and thread edit variants,
accepts trusted operator job authority or the account job's authenticated native
requester. The declaration cannot promote an
account-mode job to operator authority or replace authenticated requester identity
and current sender permission checks.

For native account edits, the host supplies its validated `requesterAccountId`
and `requesterSenderId` with `senderIsOwner: false`. There is no current inbound
conversation to put in `toolContext`. The adapter uses these host-provided facts
for its normal current requester-permission checks; model arguments and the
presence of a handoff callback cannot supply a requester identity. The host keeps
the saved native requester separate from an earlier complete-tool-surface read
origin. Discovery can use both facts to present configured actions, but the native
requester does not establish read access. Jobs without usable native facts receive
reauthorization guidance before the provider is called.

Scheduled `edit`, `delete`, `pin`, and `unpin` support both trusted operator jobs and
account jobs. An account job must use its recorded creator account and a known
creator origin; external origins also bind it to the recorded provider. Its delivery
destination does not supply authority. These actions also require
the adapter's existing `providerOwnedReadGates` declaration and retain its target
checks. Account jobs use delegated target policy; trusted jobs use operator target
policy. The job's current execution policy and `toolsAllow`, account restrictions,
enabled actions, and provider permissions still apply.

The host evaluates current tool policy when each new scheduled message invocation
is admitted, including global, agent, profile, and selected model-provider policy.
Configuration changes govern the next invocation; they do not retroactively
change the configuration of an admitted operation. Revoking or narrowing the job
itself, canceling its run, or ending caller or plugin authority still blocks later
provider requests and retries within that operation.

The host admits channel-name resolution before directory requests and retains
the selected registration through the write. Its preparation read scope closes
before the write starts, so a read completion check cannot discard an accepted
mutation result.

An opted-in adapter must honor the existing
`ChannelMessageActionContext.assertDirectAdapterHandoff` callback:

- Retain the exact host-provided callback through asynchronous preparation,
  permission and target lookups, rate-limit queues, and retries.
- Invoke it synchronously after awaited preparation and immediately before every
  actual provider request, including lookup requests and each retry attempt.
- If it throws, stop that request. Do not suppress the rejection, replace the
  callback, or put the rejected operation into replayable recovery.
- Let a submitted request settle and preserve its outcome, including a confirmed
  mutation when authority expires while awaiting the response. Expired authority
  blocks later requests; it must not cause an accepted mutation to be replayed.

This optional field keeps older adapters source-compatible. An omitted or empty
declaration leaves newly enabled scheduled actions denied. Existing bundled
provider-owned message-management paths keep their admission rules. To support
the new installed-plugin path,
upgrade OpenClaw and the plugin, implement the request and retry checks above,
declare only the covered actions, and load the updated registration. Existing
direct-operator and interactive actions retain their admission rules. Upgrading
the plugin does not grant additional authority to an existing job.

## Advanced topics

<CardGroup cols={2}>
  <Card title="Threading options" icon="git-branch" href="/plugins/sdk-channel-plugins#what-createchatchannelplugin-does-for-you">
    `threading.topLevelReplyToMode`: fixed, account-scoped, or custom reply modes
  </Card>
  <Card title="Message tool integration" icon="puzzle" href="/plugins/architecture#channel-plugins-and-the-shared-message-tool">
    describeMessageTool and action discovery
  </Card>
  <Card title="Target resolution" icon="crosshair" href="/plugins/architecture-internals#channel-target-resolution">
    inferTargetChatType, looksLikeId, reservedLiterals, resolveTarget
  </Card>
  <Card title="Runtime helpers" icon="settings" href="/plugins/sdk-runtime">
    TTS, STT, media, subagent via api.runtime
  </Card>
  <Card title="Channel inbound API" icon="bolt" href="/plugins/sdk-channel-inbound">
    Shared inbound event lifecycle: ingest, resolve, record, dispatch, finalize
  </Card>
</CardGroup>

<Note>
Some bundled helper seams still exist for bundled-plugin maintenance and
compatibility. They are not the recommended pattern for new channel plugins;
prefer the generic channel/setup/reply/runtime subpaths from the common SDK
surface unless you are maintaining that bundled plugin family directly.
</Note>

## Next steps

- [Provider Plugins](/plugins/sdk-provider-plugins) - if your plugin also provides models
- [SDK Overview](/plugins/sdk-overview) - full subpath import reference
- [SDK Testing](/plugins/sdk-testing) - test utilities and contract tests
- [Plugin Manifest](/plugins/manifest) - full manifest schema

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the seven child pages below. The anchors from the single-page version still
resolve here.

### Channel message adapter

[Channel message adapter](/plugins/sdk-channel-plugins/message-adapter) — The `message` adapter surface: live and finalizer capabilities, progress visibility, commentary delivery, and native TTS voice delivery.

- <a id="message-adapter"></a>[Message adapter](/plugins/sdk-channel-plugins/message-adapter#message-adapter)
- <a id="progress-visibility-acceptance"></a>[Progress visibility acceptance](/plugins/sdk-channel-plugins/message-adapter#progress-visibility-acceptance)
- <a id="quiet-progress-presentation"></a>[Quiet progress presentation](/plugins/sdk-channel-plugins/message-adapter#quiet-progress-presentation)
- <a id="quiet-acknowledgement-and-coalesced-progress"></a>[Quiet acknowledgement and coalesced progress](/plugins/sdk-channel-plugins/message-adapter#quiet-acknowledgement-and-coalesced-progress)
- <a id="commentary-delivery-ownership"></a>[Commentary delivery ownership](/plugins/sdk-channel-plugins/message-adapter#commentary-delivery-ownership)
- <a id="tts-voice-delivery"></a>[TTS voice delivery](/plugins/sdk-channel-plugins/message-adapter#tts-voice-delivery)

### Durable channel ingress

[Durable channel ingress](/plugins/sdk-channel-plugins/durable-ingress) — The ingress resolver, durable queue and replay dedupe, transport retention classes, at-least-once side effects, and the reload and restart contract.

- <a id="inbound-ingress-(experimental)"></a><a id="inbound-ingress-experimental"></a>[Inbound ingress (experimental)](/plugins/sdk-channel-plugins/durable-ingress#inbound-ingress-experimental)
- <a id="durable-ingress-and-replay-dedupe"></a>[Durable ingress and replay dedupe](/plugins/sdk-channel-plugins/durable-ingress#durable-ingress-and-replay-dedupe)
- <a id="transport-classes-and-retention"></a>[Transport classes and retention](/plugins/sdk-channel-plugins/durable-ingress#transport-classes-and-retention)
- <a id="at-least-once-side-effects"></a>[At-least-once side effects](/plugins/sdk-channel-plugins/durable-ingress#at-least-once-side-effects)
- <a id="dynamic-policy-publication"></a>[Dynamic policy publication](/plugins/sdk-channel-plugins/durable-ingress#dynamic-policy-publication)
- <a id="account-scoped-restart-contract"></a>[Account-scoped restart contract](/plugins/sdk-channel-plugins/durable-ingress#account-scoped-restart-contract)

### Channel status and media

[Channel status and media](/plugins/sdk-channel-plugins/status-and-media) — Channel runtime status signals plus media limits, hosted media stores, inbound media facts, and native payload shaping.

- <a id="runtime-lifecycle-status"></a>[Runtime lifecycle status](/plugins/sdk-channel-plugins/status-and-media#runtime-lifecycle-status)
- <a id="typing-indicators"></a>[Typing indicators](/plugins/sdk-channel-plugins/status-and-media#typing-indicators)
- <a id="media-source-params"></a>[Media source params](/plugins/sdk-channel-plugins/status-and-media#media-source-params)
- <a id="native-payload-shaping"></a>[Native payload shaping](/plugins/sdk-channel-plugins/status-and-media#native-payload-shaping)

### Channel sessions and bindings

[Channel sessions and bindings](/plugins/sdk-channel-plugins/sessions-and-bindings) — Session conversation grammar, conversation route ownership, and account-scoped conversation binding support.

- <a id="session-conversation-grammar"></a>[Session conversation grammar](/plugins/sdk-channel-plugins/sessions-and-bindings#session-conversation-grammar)
- <a id="conversation-route-ownership"></a>[Conversation route ownership](/plugins/sdk-channel-plugins/sessions-and-bindings#conversation-route-ownership)
- <a id="account-scoped-conversation-binding-support"></a>[Account-scoped conversation binding support](/plugins/sdk-channel-plugins/sessions-and-bindings#account-scoped-conversation-binding-support)

### Channel approvals

[Channel approvals](/plugins/sdk-channel-plugins/approvals) — Approval capabilities, approval auth, payload lifecycle and setup guidance, native approval delivery, and the narrower approval runtime subpaths.

- <a id="approvals-and-channel-capabilities"></a>[Approvals and channel capabilities](/plugins/sdk-channel-plugins/approvals#approvals-and-channel-capabilities)
- <a id="approval-auth"></a>[Approval auth](/plugins/sdk-channel-plugins/approvals#approval-auth)
- <a id="payload-lifecycle-and-setup-guidance"></a>[Payload lifecycle and setup guidance](/plugins/sdk-channel-plugins/approvals#payload-lifecycle-and-setup-guidance)
- <a id="native-approval-delivery"></a>[Native approval delivery](/plugins/sdk-channel-plugins/approvals#native-approval-delivery)
- <a id="narrower-approval-runtime-subpaths"></a>[Narrower approval runtime subpaths](/plugins/sdk-channel-plugins/approvals#narrower-approval-runtime-subpaths)

### Channel setup and config

[Channel setup and config](/plugins/sdk-channel-plugins/setup-and-config) — Setup subpaths, account schemas and inheritance, and the other narrow channel subpaths for config, inbound, targets, and threading.

- <a id="setup-subpaths"></a>[Setup subpaths](/plugins/sdk-channel-plugins/setup-and-config#setup-subpaths)
- <a id="account-schemas-and-inheritance"></a>[Account schemas and inheritance](/plugins/sdk-channel-plugins/setup-and-config#account-schemas-and-inheritance)
- <a id="other-narrow-channel-subpaths"></a>[Other narrow channel subpaths](/plugins/sdk-channel-plugins/setup-and-config#other-narrow-channel-subpaths)

### Channel mention policy

[Channel mention policy](/plugins/sdk-channel-plugins/mention-policy) — Plugin-owned mention evidence gathering plus the shared inbound mention policy evaluation.

- <a id="inbound-mention-policy"></a>[Inbound mention policy](/plugins/sdk-channel-plugins/mention-policy#inbound-mention-policy)

## Related

- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
- [Agent harness plugins](/plugins/sdk-agent-harness)
