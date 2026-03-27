---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription
access or **API key** sign-in for usage-based access. Codex cloud requires ChatGPT sign-in.
OpenAI explicitly supports subscription OAuth usage in external tools/workflows like OpenClaw.

## Option A: OpenAI API key (OpenAI Platform)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

### CLI setup

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Config snippet

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

OpenAI's current API model docs list `gpt-5.4` and `gpt-5.4-pro` for direct
OpenAI API usage. OpenClaw forwards both through the `openai/*` Responses path.
OpenClaw intentionally suppresses the stale `openai/gpt-5.3-codex-spark` row,
because direct OpenAI API calls reject it in live traffic.

OpenClaw does **not** expose `openai/gpt-5.3-codex-spark` on the direct OpenAI
API path. `pi-ai` still ships a built-in row for that model, but live OpenAI API
requests currently reject it. Spark is treated as Codex-only in OpenClaw.

## Option B: OpenAI Code (Codex) subscription

**Best for:** using ChatGPT/Codex subscription access instead of an API key.
Codex cloud requires ChatGPT sign-in, while the Codex CLI supports ChatGPT or API key sign-in.

### CLI setup (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Config snippet (Codex subscription)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

### ChatGPT apps via Codex app-server

ChatGPT apps in OpenClaw use the local `codex app-server` runtime. The
OpenAI plugin projects your existing `openai-codex` OAuth session into that
sidecar and exposes already-linked ChatGPT app tools through a managed local
MCP bridge.

Prerequisites:

- `openclaw models auth login --provider openai-codex`
- a compatible `codex` binary on `PATH`

Minimal config:

```json5
{
  plugins: {
    entries: {
      openai: {
        enabled: true,
        config: {
          chatgptApps: {
            enabled: true,
            linking: {
              enabled: true,
            },
          },
        },
      },
    },
  },
}
```

Advanced operator controls:

```json5
{
  plugins: {
    entries: {
      openai: {
        config: {
          chatgptApps: {
            enabled: true,
            chatgptBaseUrl: "https://chatgpt.com",
            appServer: {
              command: "/usr/local/bin/codex",
              args: ["--verbose"],
            },
            linking: {
              enabled: true,
              waitTimeoutMs: 60000,
              pollIntervalMs: 3000,
            },
            connectors: {
              "*": { enabled: true },
              gmail: { enabled: false },
            },
          },
        },
      },
    },
  },
}
```

Connector overrides support a wildcard entry. Use `"*": { enabled: true }` to
allow every accessible connector, then add explicit per-connector disables for
the ones you want OpenClaw to hide locally.

Use `openclaw plugins inspect openai` to inspect the ChatGPT apps runtime. Add
`--hard-refresh` when you want OpenClaw to force a fresh app-directory fetch
from the sidecar instead of reusing the current cached snapshot.

When `chatgptApps.linking.enabled` is on, OpenClaw also exposes two owner-only
local tools:

- `chatgpt_apps` lists the authoritative app inventory grouped into accessible,
  linkable, linked-but-locally-disabled, and unavailable buckets.
- `chatgpt_app_link` opens or prints the ChatGPT install URL for one app id and
  can wait for the sidecar inventory to report that the link completed.

These tools are intentionally local-only. OpenClaw does not expose them in
external chat channels such as Slack or Discord because the flow depends on the
operator completing an interactive browser step. After the link completes, the
managed MCP bridge refreshes its tool list automatically so newly linked app
tools appear without restarting the gateway.

### Manual testing ChatGPT apps

Use this checklist to verify the ChatGPT apps bridge end to end.

1. Confirm the sidecar is healthy.
   - Run `openclaw plugins inspect openai --hard-refresh`.
   - Expect the ChatGPT apps runtime section to show a running sidecar, healthy
     `sidecar` and `auth` diagnostics, and a non-empty inventory source when
     apps are available.
2. Verify the inventory tool.
   - In a local interactive OpenClaw session, ask the agent to call
     `chatgpt_apps` with `refresh: true`.
   - Expect the result to group apps into `accessible`, `linkable`,
     `linkedButLocallyDisabled`, and `unavailable`.
3. Verify one already-linked connector.
   - Pick an app from the `accessible` bucket and ask the agent to use one of
     that connector's tools.
   - Example: if Gmail is already linked, ask for a summary of recent email.
   - Expect a normal tool result from the local ChatGPT apps bridge, without
     restarting the gateway.
4. Verify the link flow for one unlinked app.
   - Pick an app from the `linkable` bucket and ask the agent to call
     `chatgpt_app_link` with that `appId`.
   - Complete the ChatGPT browser step.
   - Expect the tool to return `linked` when the inventory flips to accessible,
     or `pending` with the install URL if the flow needs more time.
5. Verify post-link refresh.
   - Run `openclaw plugins inspect openai --hard-refresh` again, or rerun
     `chatgpt_apps` with `refresh: true`.
   - Expect the app to move from `linkable` to `accessible`.
   - Expect the connector's tools to appear without restarting OpenClaw.
6. Verify local disable overrides.
   - Set `plugins.entries.openai.config.chatgptApps.connectors.<connectorId>.enabled`
     to `false` for a linked app.
   - Refresh the inventory again.
   - Expect the app to move into `linkedButLocallyDisabled`.
   - Expect that connector's tools to stop appearing through the local bridge.

Common failure signatures:

- `auth_unavailable`: OpenClaw does not currently have a usable `openai-codex`
  login. Re-run `openclaw models auth login --provider openai-codex`.
- `sidecar_unavailable`: the local `codex app-server` process could not start
  or answer.
- `app_not_found`: the `appId` is not in the current ChatGPT app inventory.
- `timed_out`: the browser flow did not finish before the link wait timeout.

### Manual testing Gmail in TUI

Use this flow when you want one concrete end-to-end connector test inside the
local TUI.

1. Confirm the OpenAI plugin is ready.
   - Run `openclaw plugins inspect openai --hard-refresh`.
   - Expect the ChatGPT apps runtime to show a healthy sidecar and auth state.
   - If you use connector overrides, make sure Gmail is not disabled at
     `plugins.entries.openai.config.chatgptApps.connectors.gmail.enabled`.
2. Start the Gateway and open the TUI.
   - Terminal 1: `openclaw gateway`
   - Terminal 2: `openclaw tui`
   - In the TUI, keep delivery off for local testing: `/deliver off`
3. Switch the session to a Codex-backed model.
   - In the TUI, run `/model openai-codex/gpt-5.4`.
   - This keeps the provider and auth path aligned with the ChatGPT apps
     bridge.
4. Check whether Gmail is already accessible.
   - Send this prompt in the TUI:

```text
Call the chatgpt_apps tool with refresh=true and tell me whether Gmail is in the accessible bucket.
```

- Expect a `chatgpt_apps` tool card in the TUI.
- Expect Gmail to appear in `accessible` if the connector is already linked.

5. Link Gmail if needed.
   - If Gmail is only `linkable`, send this prompt:

```text
Find the Gmail app id from chatgpt_apps, then call chatgpt_app_link for that app and wait for completion.
```

- Complete the browser step in ChatGPT.
- Rerun the previous inventory prompt until Gmail moves into `accessible`.

6. Invoke Gmail through the bridge.
   - Send this prompt in the TUI:

```text
Use the Gmail connector to summarize my 5 most recent unread emails. For each one, include the sender, subject, and one sentence on why it matters.
```

- Expect at least one TUI tool card whose name starts with
  `chatgpt_app__gmail__`.
- Expect the assistant response to summarize live Gmail data rather than
  answer generically.

7. Verify a second Gmail call, not just memory of the first answer.
   - Send this follow-up prompt:

```text
Open the newest thread from that summary and tell me whether it contains any action items.
```

- Expect another `chatgpt_app__gmail__` tool card.
- Expect the follow-up answer to depend on the actual thread contents.

If the TUI answer does not show a Gmail bridge tool call, make the prompt more
explicit by saying `use the Gmail connector tool` and rerun `chatgpt_apps` with
`refresh=true` first.

OpenAI's current Codex docs list `gpt-5.4` as the current Codex model. OpenClaw
maps that to `openai-codex/gpt-5.4` for ChatGPT/Codex OAuth usage.

If your Codex account is entitled to Codex Spark, OpenClaw also supports:

- `openai-codex/gpt-5.3-codex-spark`

OpenClaw treats Codex Spark as Codex-only. It does not expose a direct
`openai/gpt-5.3-codex-spark` API-key path.

OpenClaw also preserves `openai-codex/gpt-5.3-codex-spark` when `pi-ai`
discovers it. Treat it as entitlement-dependent and experimental: Codex Spark is
separate from GPT-5.4 `/fast`, and availability depends on the signed-in Codex /
ChatGPT account.

### Transport default

OpenClaw uses `pi-ai` for model streaming. For both `openai/*` and
`openai-codex/*`, default transport is `"auto"` (WebSocket-first, then SSE
fallback).

You can set `agents.defaults.models.<provider/model>.params.transport`:

- `"sse"`: force SSE
- `"websocket"`: force WebSocket
- `"auto"`: try WebSocket, then fall back to SSE

For `openai/*` (Responses API), OpenClaw also enables WebSocket warm-up by
default (`openaiWsWarmup: true`) when WebSocket transport is used.

Related OpenAI docs:

- [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI WebSocket warm-up

OpenAI docs describe warm-up as optional. OpenClaw enables it by default for
`openai/*` to reduce first-turn latency when using WebSocket transport.

### Disable warm-up

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### Enable warm-up explicitly

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAI priority processing

OpenAI's API exposes priority processing via `service_tier=priority`. In
OpenClaw, set `agents.defaults.models["openai/<model>"].params.serviceTier` to
pass that field through on direct `openai/*` Responses requests.

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

Supported values are `auto`, `default`, `flex`, and `priority`.

### OpenAI fast mode

OpenClaw exposes a shared fast-mode toggle for both `openai/*` and
`openai-codex/*` sessions:

- Chat/UI: `/fast status|on|off`
- Config: `agents.defaults.models["<provider>/<model>"].params.fastMode`

When fast mode is enabled, OpenClaw applies a low-latency OpenAI profile:

- `reasoning.effort = "low"` when the payload does not already specify reasoning
- `text.verbosity = "low"` when the payload does not already specify verbosity
- `service_tier = "priority"` for direct `openai/*` Responses calls to `api.openai.com`

Example:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
      },
    },
  },
}
```

Session overrides win over config. Clearing the session override in the Sessions UI
returns the session to the configured default.

### OpenAI Responses server-side compaction

For direct OpenAI Responses models (`openai/*` using `api: "openai-responses"` with
`baseUrl` on `api.openai.com`), OpenClaw now auto-enables OpenAI server-side
compaction payload hints:

- Forces `store: true` (unless model compat sets `supportsStore: false`)
- Injects `context_management: [{ type: "compaction", compact_threshold: ... }]`

By default, `compact_threshold` is `70%` of model `contextWindow` (or `80000`
when unavailable).

### Enable server-side compaction explicitly

Use this when you want to force `context_management` injection on compatible
Responses models (for example Azure OpenAI Responses):

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### Enable with a custom threshold

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### Disable server-side compaction

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` only controls `context_management` injection.
Direct OpenAI Responses models still force `store: true` unless compat sets
`supportsStore: false`.

## Notes

- Model refs always use `provider/model` (see [/concepts/models](/concepts/models)).
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).
