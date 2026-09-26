---
summary: "Use StepFun models with OpenClaw"
read_when:
  - You want StepFun models in OpenClaw
  - You need StepFun setup guidance
title: "StepFun"
---

StepFun ships as an external official plugin (`@openclaw/stepfun-provider`) with two provider ids:

- `stepfun` for the standard endpoint
- `stepfun-plan` for the Step Plan endpoint

<Warning>
Standard and Step Plan are **separate providers** with different endpoints and model ref prefixes (`stepfun/...` vs `stepfun-plan/...`). Use a China key with the `.com` endpoints and a global key with the `.ai` endpoints.
</Warning>

## Install plugin

```bash
openclaw plugins install @openclaw/stepfun-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Region and endpoint overview

| Endpoint  | China (`.com`)                         | Global (`.ai`)                        |
| --------- | -------------------------------------- | ------------------------------------- |
| Standard  | `https://api.stepfun.com/v1`           | `https://api.stepfun.ai/v1`           |
| Step Plan | `https://api.stepfun.com/step_plan/v1` | `https://api.stepfun.ai/step_plan/v1` |

Auth env var: `STEPFUN_API_KEY`

## Built-in catalog

Setup saves connection settings and aliases without copying generated catalog rows into your config.
Explicit `models.mode: "replace"` keeps catalog seeding enabled; custom model rows stay intact.

Standard (`stepfun`):

| Model ref                | Context   | Max output | Notes                          |
| ------------------------ | --------- | ---------- | ------------------------------ |
| `stepfun/step-3.5-flash` | 262,144   | 65,536     | Lower-cost text model          |
| `stepfun/step-3.7-flash` | 262,144   | 262,144    | Multimodal image input support |
| `stepfun/step-5-preview` | 1,048,576 | 65,536     | Default standard model         |

Step Plan (`stepfun-plan`):

| Model ref                          | Context   | Max output | Notes                          |
| ---------------------------------- | --------- | ---------- | ------------------------------ |
| `stepfun-plan/step-3.5-flash`      | 262,144   | 65,536     | Text-only model                |
| `stepfun-plan/step-3.7-flash`      | 262,144   | 262,144    | Multimodal image input support |
| `stepfun-plan/step-5-preview`      | 1,048,576 | 65,536     | Default Step Plan model        |
| `stepfun-plan/step-3.5-flash-2603` | 262,144   | 65,536     | Additional Step Plan model     |

To select Step 5 Preview after setup:

```bash
openclaw models set stepfun/step-5-preview
```

For a Step Plan subscription, use `stepfun-plan/step-5-preview` instead.
Step 5 Preview is the onboarding default for new configurations. Re-running
onboarding preserves an existing primary model; use the command above to switch it.

### Step 5 Preview usage estimates

OpenClaw estimates Standard API cost using StepFun's [published global USD rates](https://platform.stepfun.ai/docs/en/guides/pricing/details):
$1.00 per million uncached input tokens, $0.05 per million cached input tokens,
and $2.70 per million output tokens. Cache writes are included in uncached input;
reasoning tokens are included in output. These rates feed the Usage dashboard.

China endpoints use a separate [CNY price schedule](https://platform.stepfun.com/docs/zh/guides/pricing/details).
The dashboard's USD estimate is not a currency conversion of your China bill.
Step Plan catalog costs remain zero because subscriptions use plan credits rather
than Standard API token billing.

## Getting started

<Tabs>
  <Tab title="Standard">
    Best for general-purpose use via the standard StepFun endpoint.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice                    | Endpoint                     | Region        |
        | -------------------------------- | ----------------------------- | -------------- |
        | `stepfun-standard-api-key-intl` | `https://api.stepfun.ai/v1`  | International |
        | `stepfun-standard-api-key-cn`   | `https://api.stepfun.com/v1` | China          |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-intl
        ```

        China endpoint:

        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-cn
        ```
      </Step>
      <Step title="Non-interactive alternative">
        ```bash
        openclaw onboard --non-interactive --accept-risk --skip-health \
          --auth-choice stepfun-standard-api-key-intl \
          --stepfun-api-key "$STEPFUN_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider stepfun
        ```
      </Step>
    </Steps>

    Default model: `stepfun/step-5-preview`
    Alternate models: `stepfun/step-3.7-flash`, `stepfun/step-3.5-flash`

  </Tab>

  <Tab title="Step Plan">
    Best for the Step Plan reasoning endpoint.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice                 | Endpoint                                | Region        |
        | ------------------------------ | ------------------------------------------ | -------------- |
        | `stepfun-plan-api-key-intl` | `https://api.stepfun.ai/step_plan/v1`  | International |
        | `stepfun-plan-api-key-cn`   | `https://api.stepfun.com/step_plan/v1` | China          |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-intl
        ```

        China endpoint:

        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-cn
        ```
      </Step>
      <Step title="Non-interactive alternative">
        ```bash
        openclaw onboard --non-interactive --accept-risk --skip-health \
          --auth-choice stepfun-plan-api-key-intl \
          --stepfun-api-key "$STEPFUN_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider stepfun-plan
        ```
      </Step>
    </Steps>

    Default model: `stepfun-plan/step-5-preview`
    Alternate models: `stepfun-plan/step-3.5-flash`, `stepfun-plan/step-3.7-flash`, `stepfun-plan/step-3.5-flash-2603`

  </Tab>
</Tabs>

A single auth flow writes region-matched profiles for both `stepfun` and `stepfun-plan`, so both surfaces are discovered together after one onboarding run.

## Advanced configuration

In merge mode, `models: []` uses the plugin catalog, including Step 5 Preview
capabilities and pricing.

<AccordionGroup>
  <Accordion title="Full config: Standard provider">
    ```json5
    {
      env: { vars: { STEPFUN_API_KEY: "your-key" } },
      agents: { defaults: { model: { primary: "stepfun/step-5-preview" } } },
      models: {
        mode: "merge",
        providers: {
          stepfun: {
            baseUrl: "https://api.stepfun.ai/v1",
            api: "openai-completions",
            apiKey: "${STEPFUN_API_KEY}",
            models: [],
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Full config: Step Plan provider">
    ```json5
    {
      env: { vars: { STEPFUN_API_KEY: "your-key" } },
      agents: { defaults: { model: { primary: "stepfun-plan/step-5-preview" } } },
      models: {
        mode: "merge",
        providers: {
          "stepfun-plan": {
            baseUrl: "https://api.stepfun.ai/step_plan/v1",
            api: "openai-completions",
            apiKey: "${STEPFUN_API_KEY}",
            models: [],
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Notes">
    - `step-3.7-flash` and `step-5-preview` accept text and image input through OpenClaw. StepFun's API also supports video, which OpenClaw does not declare as an input modality for StepFun models.
    - Step 3.7 and Step 5 Preview support `low`, `medium`, and `high` reasoning effort. Because the model has no non-reasoning mode, `/think off` maps to `low`.
    - `step-3.5-flash-2603` is exposed only on `stepfun-plan`.
    - Use `openclaw models list` and `openclaw models set <provider/model>` to inspect or switch models.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema for providers, models, and plugins.
  </Card>
  <Card title="Models CLI" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="StepFun Platform" href="https://platform.stepfun.com" icon="globe">
    StepFun API key management and documentation.
  </Card>
</CardGroup>
