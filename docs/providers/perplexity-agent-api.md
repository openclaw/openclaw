---
summary: "Use Perplexity Agent API as a custom LLM provider, MCP server, or CLI companion"
title: "Perplexity Agent API"
read_when:
  - You want to use Perplexity Agent API models from OpenClaw
  - You want to connect Perplexity's MCP server to OpenClaw
  - You need SecretRef-safe Perplexity custom-provider setup
---

Perplexity's [Agent API](https://docs.perplexity.ai/docs/agent-api/quickstart)
exposes models from Anthropic, Google, OpenAI, xAI, and other providers through
an OpenAI-Responses-compatible endpoint. OpenClaw can use Perplexity in three
separate ways: as an LLM model provider, as an MCP tool provider, or as a CLI
that an agent invokes through the shell.

<Note>
This page covers the model-provider, MCP, and CLI paths. For Perplexity as
OpenClaw's managed `web_search` provider, see
[Perplexity](/providers/perplexity-provider).
</Note>

| Property    | Value                                                               |
| ----------- | ------------------------------------------------------------------- |
| Type        | Model provider (custom OpenAI Responses backend)                    |
| API         | `openai-responses`                                                  |
| Base URL    | `https://api.perplexity.ai/v1`                                      |
| Auth        | `PERPLEXITY_API_KEY` (Perplexity API key, prefix `pplx-`)           |
| Get a key   | [console.perplexity.ai](https://console.perplexity.ai/project/keys) |
| Provider ID | `perplexity`                                                        |

## Required tool configuration

Perplexity Agent API owns server-side built-in tools. The non-interactive
onboarding flow below makes the selected Perplexity model the shared default on
a Gateway without explicit ownership. On a fleet with
`agents.ownership: "explicit"`, it changes only the configured system agent.
Before running it, apply the tool guard at that same scope so the agent receiving
the model does not send a custom function whose name Perplexity reserves.

For a shared default, disable OpenClaw's managed `web_search` Gateway-wide:

```json5
{
  tools: {
    web: {
      search: { enabled: false },
    },
  },
}
```

`tools.web.search.enabled: false` affects every agent on the Gateway. For an
explicit fleet, preserve managed search for unrelated agents and add
`web_search` to the system agent's existing deny list before onboarding (replace
`research` with the value of `agents.defaults.systemAgent.agentId`):

```json5
{
  agents: {
    entries: {
      research: {
        tools: { deny: ["web_search"] },
      },
    },
  },
}
```

Onboarding writes the Perplexity model to that same explicit agent. Do not use
the Gateway-wide disable for this path unless you intend to disable managed
search for every agent.

<Warning>
Do not combine a shared Perplexity default with a deny rule on only one named
agent. Every other agent inheriting that default would still expose the reserved
function name. Scope the model and deny rule together, use the Gateway-wide
disable, or run the Perplexity agent in a separate Gateway profile.
</Warning>

Perplexity reserves these custom-function names for its built-in tools:

- `web_search`
- `fetch_url`
- `people_search`
- `finance_search`

See Perplexity's [OpenClaw integration guide](https://docs.perplexity.ai/docs/getting-started/integrations/openclaw)
for the vendor-owned contract.

## Onboard the model provider

<Steps>
  <Step title="Get an API key">
    Create a `pplx-...` key in the
    [Perplexity API console](https://console.perplexity.ai/project/keys).
  </Step>

  <Step title="Persist a daemon-visible credential">
    Non-interactive custom-provider onboarding reads `CUSTOM_API_KEY`. An
    installed Gateway also needs a durable environment source after the current
    shell exits.

    If no existing custom provider uses `CUSTOM_API_KEY`, write it to the
    state-directory `.env` before onboarding:

    ```bash
    export PERPLEXITY_API_KEY="pplx-..."
    state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    umask 077
    mkdir -p "$state_dir"
    printf 'CUSTOM_API_KEY=%s\n' "$PERPLEXITY_API_KEY" >> "$state_dir/.env"
    chmod 600 "$state_dir/.env"
    export CUSTOM_API_KEY="$PERPLEXITY_API_KEY"
    ```

    Use this only when `CUSTOM_API_KEY` is absent from both the shell and the
    state-directory `.env`. Do not replace a value already owned by another
    custom provider.

    If another provider already uses `CUSTOM_API_KEY`, preserve it and add a
    provider-specific variable instead:

    ```bash
    export PERPLEXITY_API_KEY="pplx-..."
    state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    umask 077
    mkdir -p "$state_dir"
    printf 'PERPLEXITY_API_KEY=%s\n' "$PERPLEXITY_API_KEY" >> "$state_dir/.env"
    chmod 600 "$state_dir/.env"
    ```

    Update an existing line instead of appending a second definition. The
    state-directory `.env` is a durable source for installed Gateway services;
    a shell export alone disappears with that shell. See
    [Environment variables](/help/environment).

  </Step>

  <Step title="Guard the model owner before onboarding">
    Inspect the Gateway's ownership mode:

    ```bash
    openclaw config get agents.ownership
    ```

    When ownership is unset, onboarding changes the shared default. Apply the
    Gateway-wide guard first and leave it disabled while Perplexity remains the
    shared default:

    ```bash
    openclaw config set tools.web.search.enabled false
    ```

    When the value is `explicit`, onboarding changes the configured system
    agent instead. Read its ID:

    ```bash
    openclaw config get agents.defaults.systemAgent.agentId
    ```

    Before onboarding, edit that agent's `tools.deny` list to include
    `web_search`, preserving any existing entries. For example, for an agent ID
    of `research`:

    ```json5
    {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "research" } },
        entries: {
          research: { tools: { deny: ["web_search"] } },
        },
      },
    }
    ```

    This scoped guard leaves managed search available to unrelated agents. Do
    not apply the Gateway-wide disable in an explicit fleet unless that broader
    effect is intentional.

  </Step>

  <Step title="Run non-interactive onboarding">
    For a fresh `CUSTOM_API_KEY`, run:

    ```bash
    openclaw onboard \
      --non-interactive \
      --accept-risk \
      --auth-choice custom-api-key \
      --secret-input-mode ref \
      --custom-base-url "https://api.perplexity.ai/v1" \
      --custom-model-id "anthropic/claude-sonnet-4-6" \
      --custom-compatibility openai-responses \
      --custom-provider-id perplexity \
      --install-daemon
    ```

    If another provider owns `CUSTOM_API_KEY`, keep it unchanged. Mask it only
    for onboarding, replace the optional-key result with a Perplexity-specific
    SecretRef, and install the daemon after the reference is present:

    ```bash
    CUSTOM_API_KEY= openclaw onboard \
      --non-interactive \
      --accept-risk \
      --auth-choice custom-api-key \
      --secret-input-mode ref \
      --custom-base-url "https://api.perplexity.ai/v1" \
      --custom-model-id "anthropic/claude-sonnet-4-6" \
      --custom-compatibility openai-responses \
      --custom-provider-id perplexity

    openclaw config set models.providers.perplexity.apiKey \
      --ref-source env \
      --ref-provider default \
      --ref-id PERPLEXITY_API_KEY

    openclaw gateway install
    ```

    If your environment SecretRef provider alias is not `default`, pass the
    configured alias to `--ref-provider`. Prefixing only the onboarding command
    with `CUSTOM_API_KEY=` does not change the existing shell or `.env` value.

    `--non-interactive` selects direct flag consumption. `--accept-risk` is
    required with it; without that acknowledgement onboarding exits before
    setup dispatch. `--secret-input-mode ref` stores a complete environment
    SecretRef instead of a literal key.

  </Step>

  <Step title="Register additional models">
    Onboarding registers one model. Add every other model you need explicitly
    under `models.providers.perplexity.models[]`. The Perplexity web-search
    plugin does not own an LLM model-catalog integration, and an
    `agents.defaults.models` entry alone does not register a custom-provider
    model. Use the current IDs and metadata from Perplexity's
    [Agent API model catalog](https://docs.perplexity.ai/docs/agent-api/models).
  </Step>
</Steps>

## SecretRef activation

On a default secrets setup, the fresh path stores:

```json5
{
  source: "env",
  provider: "default",
  id: "CUSTOM_API_KEY",
}
```

The existing-custom-provider path replaces that onboarding result with the same
complete shape but uses `id: "PERPLEXITY_API_KEY"`. A configured non-default
environment-provider alias appears in `provider` instead of `default`.

The Gateway resolves SecretRefs during startup or reload and publishes the
resolved value in its active in-memory snapshot. Request paths read that
snapshot; they do not re-read the environment for every request. After rotating
the value, restart or reload the Gateway, or run `openclaw secrets reload`, to
activate it. See [Secrets management](/gateway/secrets#runtime-model) and
[Reload runtime snapshot](/cli/secrets#reload-runtime-snapshot).

## Transport and base URL

`--custom-compatibility openai-responses` is required. Perplexity's canonical
Agent API endpoint is `POST /v1/agent`, and `POST /v1/responses` is its OpenAI
Responses compatibility alias. OpenClaw's `openai-responses` transport appends
`/responses`, so configure the base URL as exactly
`https://api.perplexity.ai/v1`.

| Correct base URL               | Do not use as a base URL                 |
| ------------------------------ | ---------------------------------------- |
| `https://api.perplexity.ai/v1` | `https://api.perplexity.ai/v1/agent`     |
|                                | `https://api.perplexity.ai/v1/responses` |
|                                | `https://api.perplexity.ai`              |

The first two incorrect values cause a duplicated suffix; the third omits
`/v1`. The `/v1/agent` and `/v1/responses` interfaces expect Responses-style
payloads. Selecting `openai-completions` sends a different request to
`/chat/completions`; it does not configure this Agent API model-provider path.

## Config shape

Onboarding writes the full provider and starter-model metadata. For the shared-
default path, the important shape is:

```json5
{
  agents: {
    defaults: {
      model: { primary: "perplexity/anthropic/claude-sonnet-4-6" },
    },
  },
  tools: {
    web: {
      search: { enabled: false },
    },
  },
  models: {
    mode: "merge",
    providers: {
      perplexity: {
        baseUrl: "https://api.perplexity.ai/v1",
        apiKey: {
          source: "env",
          provider: "default",
          id: "CUSTOM_API_KEY",
        },
        api: "openai-responses",
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6 (Perplexity)",
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
}
```

The zero cost fields are onboarding metadata, not a claim that Perplexity usage
is free. Consult Perplexity's current model catalog for billing and update local
metadata when you use it for cost reporting. If `CUSTOM_API_KEY` already belongs
to another provider, use `PERPLEXITY_API_KEY` in the SecretRef instead.

Model IDs under the provider omit the provider prefix. For example, config ID
`anthropic/claude-sonnet-4-6` becomes full OpenClaw reference
`perplexity/anthropic/claude-sonnet-4-6`.

## Perplexity MCP server

Perplexity's [MCP server](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server)
exposes `perplexity_search`, `perplexity_ask`, `perplexity_research`, and
`perplexity_reason`. This is separate from model-provider setup: Agent API can
drive the model while MCP supplies callable Perplexity tools, and both can be
enabled together.

Follow OpenClaw's [Connect MCP servers](/tools/mcp) guide, using the endpoint and
authentication contract from Perplexity's MCP docs. Those guides cover remote
Streamable HTTP and local stdio patterns without embedding an expanded API key
in `openclaw.json`.

## Perplexity CLI

Perplexity also publishes the [`pplx` CLI](https://docs.perplexity.ai/docs/cli/overview).
It is a terminal companion, not an OpenClaw model provider or MCP server. An
OpenClaw agent with the `exec` tool can invoke it from the shell:

```bash
export PERPLEXITY_API_KEY=pplx-...
pplx search web "kubernetes pod OOMKilled causes" -n 5
pplx content snippets "how does a bloom filter decide set membership" \
  https://en.wikipedia.org/wiki/Bloom_filter
```

Install the CLI using Perplexity's official instructions and make the credential
available to the process that runs it. No `openclaw.json` change is required.

## Related

<CardGroup cols={2}>
  <Card title="Perplexity web search provider" href="/providers/perplexity-provider" icon="magnifying-glass">
    Perplexity as OpenClaw's managed `web_search` backend.
  </Card>
  <Card title="Connect MCP servers" href="/tools/mcp" icon="plug">
    OpenClaw MCP transports, configuration, and credential handling.
  </Card>
  <Card title="Perplexity OpenClaw guide" href="https://docs.perplexity.ai/docs/getting-started/integrations/openclaw" icon="book">
    Perplexity's vendor-owned OpenClaw integration guide.
  </Card>
  <Card title="Agent API models" href="https://docs.perplexity.ai/docs/agent-api/models" icon="list">
    Current model IDs, limits, and pricing.
  </Card>
</CardGroup>
