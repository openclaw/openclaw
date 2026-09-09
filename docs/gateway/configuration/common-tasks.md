---
summary: "Task-oriented configuration recipes: channels, models, access, sessions, sandboxing, cron, hooks, routing, and $include"
title: "Common tasks"
sidebarTitle: "Common tasks"
read_when:
  - Looking for a copy-paste config for a common setup
  - Setting up a channel, model, access rule, or automation
  - Splitting one config file into several with $include
---

## Common tasks

<AccordionGroup>
  <Accordion title="Set up a channel (WhatsApp, Telegram, Discord, etc.)">
    Each channel has its own config section under `channels.<provider>`. See the dedicated channel page for setup steps:

    - [Discord](/channels/discord) - `channels.discord`
    - [Feishu](/channels/feishu) - `channels.feishu`
    - [Google Chat](/channels/googlechat) - `channels.googlechat`
    - [iMessage](/channels/imessage) - `channels.imessage`
    - [Mattermost](/channels/mattermost) - `channels.mattermost`
    - [Microsoft Teams](/channels/msteams) - `channels.msteams`
    - [Signal](/channels/signal) - `channels.signal`
    - [Slack](/channels/slack) - `channels.slack`
    - [Telegram](/channels/telegram) - `channels.telegram`
    - [WhatsApp](/channels/whatsapp) - `channels.whatsapp`

    All channels share the same DM policy pattern:

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // only for allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Choose and configure models">
    Set the primary model and optional fallbacks:

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.4": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` stores aliases and per-model settings; adding an entry never restricts `/model` or `--model` overrides.
    - `agents.defaults.modelPolicy.allow` is the explicit allowlist for overrides and model pickers. It accepts exact refs and `provider/*` wildcards; omit it or use `[]` to allow any model.
    - Model refs use `provider/model` format (e.g. `anthropic/claude-opus-4-6`).
    - `agents.defaults.imageMaxDimensionPx` controls transcript/tool image downscaling (default `1200`); lower values usually reduce vision-token usage on screenshot-heavy runs.
    - See [Models CLI](/concepts/models) for switching models in chat and [Model Failover](/concepts/model-failover) for auth rotation and fallback behavior.
    - For custom/self-hosted providers, see [Custom providers](/gateway/config-tools#custom-providers-and-base-urls) in the reference.

  </Accordion>

  <Accordion title="Control who can message the bot">
    DM access is controlled per channel via `dmPolicy` (default `"pairing"`):

    - `"pairing"`: unknown senders get a one-time pairing code to approve
    - `"allowlist"`: only senders in `allowFrom` (or the paired allow store)
    - `"open"`: allow all inbound DMs (requires `allowFrom: ["*"]`)
    - `"disabled"`: ignore all DMs

    For groups, use `groupPolicy` (`"allowlist" | "open" | "disabled"`) plus `groupAllowFrom` or channel-specific allowlists.

    See the [full reference](/gateway/config-channels#dm-and-group-access) for per-channel details.

  </Accordion>

  <Accordion title="Set up group chat mention gating">
    Group messages default to **require mention**. Configure trigger patterns per agent. Normal group/channel replies post automatically; opt into the message-tool path for shared rooms where the agent should decide when to speak:

    ```json5
    {
      messages: {
        visibleReplies: "automatic", // set "message_tool" to require message-tool sends everywhere
        groupChat: {
          visibleReplies: "message_tool", // opt-in; visible output requires message(action=send)
          unmentionedInbound: "room_event", // unmentioned always-on group chatter is quiet context
        },
      },
      agents: {
        entries: {
          main: {
            default: true,
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        },
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **Metadata mentions**: native @-mentions (WhatsApp tap-to-mention, Telegram @bot, etc.)
    - **Text patterns**: safe regex patterns in `mentionPatterns`
    - **Visible replies**: `messages.visibleReplies` can require message-tool sends globally; `messages.groupChat.visibleReplies` overrides that for groups/channels.
    - See [full reference](/gateway/config-channels#group-chat-mention-gating) for visible reply modes, per-channel overrides, and self-chat mode.

  </Accordion>

  <Accordion title="Restrict skills per agent">
    Use `agents.defaults.skills` for a shared baseline, then override specific
    agents with `agents.entries.*.skills`:

    ```json5
    {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        entries: {
          writer: { default: true }, // inherits github, weather
          docs: { skills: ["docs-search"] }, // replaces defaults
          "locked-down": { skills: [] }, // no skills
        },
      },
    }
    ```

    - Omit `agents.defaults.skills` for unrestricted skills by default.
    - Omit `agents.entries.*.skills` to inherit the defaults.
    - Set `agents.entries.*.skills: []` for no skills.
    - See [Skills](/tools/skills), [Skills config](/tools/skills-config), and
      the [Configuration Reference](/gateway/config-agents/workspace-and-bootstrap#agents-defaults-skills).

  </Accordion>

  <Accordion title="Configure per-channel health monitoring">
    Disable or enable automatic health restarts for a channel or account:

    ```json5
    {
      channels: {
        telegram: {
          healthMonitor: { enabled: false },
          accounts: {
            alerts: {
              healthMonitor: { enabled: true },
            },
          },
        },
      },
    }
    ```

    - Use `channels.<provider>.healthMonitor.enabled` or `channels.<provider>.accounts.<id>.healthMonitor.enabled` to control auto-restarts for one channel or account.
    - See [Health Checks](/gateway/health) for operational debugging and the [full reference](/gateway/config-gateway#gateway) for all fields.

  </Accordion>

  <Accordion title="Configure sessions and resets">
    Sessions control conversation continuity and isolation:

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recommended for multi-user
        threadBindings: {
          enabled: true,
          idleHours: 24,
          maxAgeHours: 0,
        },
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (shared) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`: global defaults for thread-bound session routing. Spawn with `sessions_spawn({ thread: true })` or `/acp spawn --thread auto`. Use `/session unbind`, `/agents`, `/session idle`, and `/session max-age` to detach, list, and tune bindings (Discord binds threads, Telegram binds topics/conversations).
    - See [Session Management](/concepts/session) for scoping, identity links, and send policy.
    - See [full reference](/gateway/config-agents/sessions#session) for all fields.

  </Accordion>

  <Accordion title="Enable sandboxing">
    Run agent sessions in isolated sandbox runtimes:

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    Build the image first - from a source checkout run `scripts/sandbox-setup.sh`, or from an npm install see the inline `docker build` command in [Sandboxing § Images and setup](/gateway/sandboxing#images-and-setup).

    See [Sandboxing](/gateway/sandboxing) for the full guide and [full reference](/gateway/config-agents/sandbox#agentsdefaultssandbox) for all options.

  </Accordion>

  <Accordion title="Enable relay-backed push for official iOS builds">
    Relay-backed push for public App Store builds uses the hosted OpenClaw relay: `https://ios-push-relay.openclaw.ai`.

    Custom relay deployments require a deliberately separate iOS build/deployment path whose relay URL matches the gateway relay URL. If you are using a custom relay build, set this in gateway config:

    ```json5
    {
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              // Optional. Default: 10000
              timeoutMs: 10000,
            },
          },
        },
      },
    }
    ```

    CLI equivalent:

    ```bash
    openclaw config set gateway.push.apns.relay.baseUrl https://relay.example.com
    ```

    What this does:

    - Lets the gateway send `push.test`, wake nudges, and reconnect wakes through the external relay.
    - Uses a registration-scoped send grant forwarded by the paired iOS app. The gateway does not need a deployment-wide relay token.
    - Binds each relay-backed registration to the gateway identity that the iOS app paired with, so another gateway cannot reuse the stored registration.
    - Keeps local/manual iOS builds on direct APNs. Relay-backed sends apply only to official distributed builds that registered through the relay.
    - Must match the relay base URL baked into the iOS build, so registration and send traffic reach the same relay deployment.

    End-to-end flow:

    1. Install the official iOS app.
    2. Optional: configure `gateway.push.apns.relay.baseUrl` on the gateway only when using a deliberately separate custom relay build.
    3. Pair the iOS app to the gateway and let both node and operator sessions connect.
    4. The iOS app fetches the gateway identity, registers with the relay using App Attest plus the app receipt, and then publishes the relay-backed `push.apns.register` payload to the paired gateway.
    5. The gateway stores the relay handle and send grant, then uses them for `push.test`, wake nudges, and reconnect wakes.

    Operational notes:

    - If you switch the iOS app to a different gateway, reconnect the app so it can publish a new relay registration bound to that gateway.
    - If you ship a new iOS build that points at a different relay deployment, the app refreshes its cached relay registration instead of reusing the old relay origin.

    Compatibility note:

    - `OPENCLAW_APNS_RELAY_BASE_URL` and `OPENCLAW_APNS_RELAY_TIMEOUT_MS` still work as temporary env overrides.
    - Custom gateway relay URLs must match the relay base URL baked into the iOS build; the public App Store release lane rejects custom iOS relay URL overrides.
    - `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true` remains a loopback-only development escape hatch; do not persist HTTP relay URLs in config.

    See [iOS App](/platforms/ios#relay-backed-push-for-official-builds) for the end-to-end flow and [Authentication and trust flow](/platforms/ios#authentication-and-trust-flow) for the relay security model.

  </Accordion>

  <Accordion title="Set up heartbeat (periodic check-ins)">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "owner",
          },
        },
      },
    }
    ```

    - `every`: duration string (`30m`, `2h`). Set `0m` to disable recurring cadence; targeted event-driven wakes can still run one agent turn. Default: `30m`.
    - `target`: `owner` (default operator DM) | `last` (latest conversation, including groups) | `none` (internal only) | `<channel-id>`
    - `directPolicy`: `allow` (default) or `block` for DM-style heartbeat targets
    - See [Heartbeat](/gateway/heartbeat) for the full guide.

  </Accordion>

  <Accordion title="Configure cron jobs">
    ```json5
    {
      cron: {
        enabled: true,
        sessionRetention: "24h",
      },
    }
    ```

    - `sessionRetention`: prune completed isolated run sessions from SQLite session rows (default `24h`; set `false` or a zero duration such as `"0h"` to disable).
    - Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.
    - See [Cron jobs](/automation/cron-jobs) for feature overview and CLI examples.

  </Accordion>

  <Accordion title="Set up webhooks (hooks)">
    Enable HTTP webhook endpoints on the Gateway:

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            sessionKey: "hook:gmail",
            sessionMode: "persistent",
            deliver: true,
          },
        ],
      },
    }
    ```

    Security note:
    - Treat all hook/webhook payload content as untrusted input.
    - Use a dedicated `hooks.token`; do not reuse active Gateway auth secrets (`gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`).
    - Hook auth is header-only (`Authorization: Bearer ...` or `x-openclaw-token`); query-string tokens are rejected.
    - `hooks.path` cannot be `/`; keep webhook ingress on a dedicated subpath such as `/hooks`.
    - Keep unsafe-content bypass flags disabled (`hooks.gmail.allowUnsafeExternalContent`, `hooks.mappings[].allowUnsafeExternalContent`) unless doing tightly scoped debugging.
    - If you enable `hooks.allowRequestSessionKey`, also set `hooks.allowedSessionKeyPrefixes` to bound caller-selected session keys.
    - Keep hook sessions isolated unless durable context is intentional. Direct persistent hooks require an explicit, prefix-bounded request `sessionKey`; mapped persistent hooks require a stable mapping key or `hooks.defaultSessionKey`.
    - For hook-driven agents, prefer strong modern model tiers and strict tool policy (for example messaging-only plus sandboxing where possible).

    See [full reference](/gateway/config-hooks#hooks) for all mapping options and Gmail integration.

  </Accordion>

  <Accordion title="Configure multi-agent routing">
    Run multiple isolated agents with separate workspaces and sessions:

    ```json5
    {
      agents: {
        entries: {
          home: { default: true, workspace: "~/.openclaw/workspace-home" },
          work: { workspace: "~/.openclaw/workspace-work" },
        },
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

    See [Multi-Agent](/concepts/multi-agent) and [full reference](/gateway/config-agents/entries-and-multi-agent#multi-agent-routing) for binding rules and per-agent access profiles.

  </Accordion>

  <Accordion title="Split config into multiple files ($include)">
    Use `$include` to organize large configs:

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **Single file**: replaces the containing object
    - **Array of files**: deep-merged in order (later wins), up to 10 nested levels deep
    - **Sibling keys**: merged after includes (override included values)
    - **Relative paths**: resolved relative to the including file
    - **Path format**: include paths must not contain null bytes and must be strictly shorter than 4096 characters before and after resolution
    - **OpenClaw-owned writes**: when every changed key is owned by one
      single-file include at an object-key path, OpenClaw updates the deepest
      owning include and leaves `openclaw.json` intact. This works for both
      top-level sections such as `plugins: { $include: "./plugins.json5" }` and
      nested object-map entries. Write-through only targets include files inside
      the top-level config directory; includes admitted through
      `OPENCLAW_INCLUDE_ROOTS` stay read-only for OpenClaw-owned writes.
    - **Unsupported write-through**: root includes (every section of a config
      whose root object authors `$include`), actual array-entry includes,
      include arrays, sibling overrides, files shared by multiple logical paths,
      changes spanning ownership boundaries,
      any nested include beneath a merged owner, and any include whose own file
      still authors a nested `$include` directive fail closed instead of
      flattening the config. Numeric object keys are treated as map keys, not
      array positions.
      Include targets and contents are rechecked around persistence; a concurrent
      edit to an intermediate include refuses the write or rolls back its unchanged leaf.
    - **Doctor repairs**: `openclaw doctor --fix` writes through the same
      boundary. A run whose candidate mixes a root-owned repair with an
      include-owned repair is refused as a whole. That refused write leaves every
      file unchanged (earlier writes in the same run stay saved), and Doctor names
      the boundary to repair by hand before rerunning, plus the included file or
      files when the root file authors that boundary's `$include` (an agent-roster
      boundary is named without its file).
    - **Confinement**: `$include` paths must resolve under the directory holding
      `openclaw.json`. To share a tree across machines or users, set
      `OPENCLAW_INCLUDE_ROOTS` to a path-list (`:` on POSIX, `;` on Windows) of
      additional directories that includes may reference. Symlinks are resolved
      and re-checked, so a path that lexically lives in a config dir but whose
      real target escapes every allowed root is still rejected.
    - **Error handling**: clear errors for missing files, parse errors, circular includes, invalid path format, and excessive length

  </Accordion>
</AccordionGroup>
