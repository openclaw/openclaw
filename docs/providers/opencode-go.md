---
summary: "Use the OpenCode Go catalog with the shared OpenCode setup"
read_when:
  - You want the OpenCode Go catalog
  - You need the runtime model refs for Go-hosted models
title: "OpenCode Go"
---

OpenCode Go is the Go catalog within [OpenCode](/providers/opencode).
It uses the same `OPENCODE_API_KEY` as the Zen catalog, but keeps the runtime
provider id `opencode-go` so upstream per-model routing stays correct.

| Property         | Value                           |
| ---------------- | ------------------------------- |
| Runtime provider | `opencode-go`                   |
| Auth             | `OPENCODE_API_KEY`              |
| Parent setup     | [OpenCode](/providers/opencode) |

## Built-in catalog

OpenClaw ships the bundled OpenCode Go catalog directly for sync lookups and
model listing. Run `openclaw models list --provider opencode-go` for the current
installed list.

The provider includes:

| Model ref                       | Name              |
| ------------------------------- | ----------------- |
| `opencode-go/deepseek-v4-flash` | DeepSeek V4 Flash |
| `opencode-go/deepseek-v4-pro`   | DeepSeek V4 Pro   |
| `opencode-go/glm-5`             | GLM-5             |
| `opencode-go/glm-5.1`           | GLM-5.1           |
| `opencode-go/kimi-k2.6`         | Kimi K2.6         |
| `opencode-go/kimi-k2.7-code`    | Kimi K2.7 Code    |
| `opencode-go/mimo-v2.5`         | MiMo V2.5         |
| `opencode-go/mimo-v2.5-pro`     | MiMo V2.5 Pro     |
| `opencode-go/minimax-m2.7`      | MiniMax M2.7      |
| `opencode-go/minimax-m3`        | MiniMax M3        |
| `opencode-go/qwen3.6-plus`      | Qwen3.6 Plus      |
| `opencode-go/qwen3.7-max`       | Qwen3.7 Max       |
| `opencode-go/qwen3.7-plus`      | Qwen3.7 Plus      |

## Getting started

<Tabs>
  <Tab title="Interactive">
    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice opencode-go
        ```
      </Step>
      <Step title="Set a Go model as default">
        ```bash
        openclaw config set agents.defaults.model.primary "opencode-go/kimi-k2.7-code"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider opencode-go
        ```
      </Step>
    </Steps>
  </Tab>

  <Tab title="Non-interactive">
    <Steps>
      <Step title="Pass the key directly">
        ```bash
        openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
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
  env: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.7-code" } } },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Routing behavior">
    OpenClaw handles per-model routing automatically when the model ref uses
    `opencode-go/...`. No additional provider config is required.
  </Accordion>

  <Accordion title="Runtime ref convention">
    Runtime refs stay explicit: `opencode/...` for Zen, `opencode-go/...` for Go.
    This keeps upstream per-model routing correct across both catalogs.
  </Accordion>

  <Accordion title="Shared credentials">
    The same `OPENCODE_API_KEY` is used by both the Zen and Go catalogs. Entering
    the key during setup stores credentials for both runtime providers.
  </Accordion>
</AccordionGroup>

<Tip>
See [OpenCode](/providers/opencode) for the shared onboarding overview and the full
Zen + Go catalog reference.
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="OpenCode (parent)" href="/providers/opencode" icon="server">
    Shared onboarding, catalog overview, and advanced notes.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
