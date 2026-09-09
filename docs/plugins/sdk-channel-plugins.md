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
generic `:thread:` bookkeeping, and dispatch.

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
    `retainNativeCatalog(provider)` is deprecated and will be removed in the
    next breaking SDK release; existing calls only assert that the captured
    registry generation is still active.
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

## Advanced topics

<CardGroup cols={2}>
  <Card title="Threading options" icon="git-branch" href="/plugins/sdk-entrypoints#registration-mode">
    Fixed, account-scoped, or custom reply modes
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
