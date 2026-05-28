---
summary: "Use OpenCode Zen and Go catalogs with OpenClaw"
read_when:
  - You want OpenCode-hosted model access
  - You want to pick between the Zen and Go catalogs
title: "OpenCode"
---

OpenCode exposes two hosted catalogs in OpenClaw:

| Catalog | Prefix            | Runtime provider |
| ------- | ----------------- | ---------------- |
| **Zen** | `opencode/...`    | `opencode`       |
| **Go**  | `opencode-go/...` | `opencode-go`    |

OpenClaw keeps the runtime provider ids split so upstream per-model routing stays
correct. Zen prefers `OPENCODE_ZEN_API_KEY`, Go prefers `OPENCODE_GO_API_KEY`, and
both can still fall back to `OPENCODE_API_KEY` when you want one shared key.

## Getting started

<Tabs>
  <Tab title="Zen catalog">
    **Best for:** the curated OpenCode multi-model proxy (Claude, GPT, Gemini).

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice opencode-zen
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --opencode-zen-api-key "$OPENCODE_ZEN_API_KEY"
        ```
      </Step>
      <Step title="Set a Zen model as the default">
        ```bash
        openclaw config set agents.defaults.model.primary "opencode/claude-opus-4-6"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider opencode
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Go catalog">
    **Best for:** the OpenCode-hosted Kimi, GLM, and MiniMax lineup.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice opencode-go
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --opencode-go-api-key "$OPENCODE_GO_API_KEY"
        ```
      </Step>
      <Step title="Set a Go model as the default">
        ```bash
        openclaw config set agents.defaults.model.primary "opencode-go/kimi-k2.6"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider opencode-go
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Config example

```json5
{
  env: {
    OPENCODE_ZEN_API_KEY: "sk-zen-...",
    OPENCODE_GO_API_KEY: "sk-go-...",
  },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Built-in catalogs

### Zen

| Property         | Value                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| Runtime provider | `opencode`                                                              |
| Example models   | `opencode/claude-opus-4-6`, `opencode/gpt-5.5`, `opencode/gemini-3-pro` |

### Go

| Property         | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Runtime provider | `opencode-go`                                                            |
| Example models   | `opencode-go/kimi-k2.6`, `opencode-go/glm-5`, `opencode-go/minimax-m2.5` |

## Advanced configuration

<AccordionGroup>
  <Accordion title="API key aliases">
    Zen prefers `OPENCODE_ZEN_API_KEY`. Go prefers `OPENCODE_GO_API_KEY`. Both
    providers still accept `OPENCODE_API_KEY` as a shared fallback.
  </Accordion>

  <Accordion title="Shared credentials">
    If you want one shared key, set `OPENCODE_API_KEY`. If you want split
    credentials, onboard Zen and Go separately with their provider-specific keys.
  </Accordion>

  <Accordion title="Billing and dashboard">
    You sign in to OpenCode, add billing details, and copy your API key. Billing
    and catalog availability are managed from the OpenCode dashboard.
  </Accordion>

  <Accordion title="Gemini replay behavior">
    Gemini-backed OpenCode refs stay on the proxy-Gemini path, so OpenClaw keeps
    Gemini thought-signature sanitation there without enabling native Gemini
    replay validation or bootstrap rewrites.
  </Accordion>

  <Accordion title="Non-Gemini replay behavior">
    Non-Gemini OpenCode refs keep the minimal OpenAI-compatible replay policy.
  </Accordion>
</AccordionGroup>

<Tip>
If you set only `OPENCODE_API_KEY`, both Zen and Go can reuse it. If you need
separate credentials, use `OPENCODE_ZEN_API_KEY` and `OPENCODE_GO_API_KEY`.
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
