---
summary: "Use StepFun text and image models with OpenClaw"
read_when:
  - You want StepFun models in OpenClaw
  - You need StepFun setup guidance
  - You want StepFun image generation or editing
title: "StepFun"
---

OpenClaw includes a bundled StepFun provider plugin with two provider ids:

- `stepfun` for the standard endpoint
- `stepfun-plan` for the Step Plan endpoint

<Warning>
Standard and Step Plan are **separate providers** with different endpoints and model ref prefixes (`stepfun/...` vs `stepfun-plan/...`). Use a China key with the `.com` endpoints and a global key with the `.ai` endpoints.
</Warning>

## Region and endpoint overview

| Endpoint  | China (`.com`)                         | Global (`.ai`)                        |
| --------- | -------------------------------------- | ------------------------------------- |
| Standard  | `https://api.stepfun.com/v1`           | `https://api.stepfun.ai/v1`           |
| Step Plan | `https://api.stepfun.com/step_plan/v1` | `https://api.stepfun.ai/step_plan/v1` |

Auth env var: `STEPFUN_API_KEY`

## Built-in catalog

Standard (`stepfun`):

| Model ref                | Context | Max output | Notes                  |
| ------------------------ | ------- | ---------- | ---------------------- |
| `stepfun/step-3.5-flash` | 262,144 | 65,536     | Default standard model |

Step Plan (`stepfun-plan`):

| Model ref                          | Context | Max output | Notes                      |
| ---------------------------------- | ------- | ---------- | -------------------------- |
| `stepfun-plan/step-3.5-flash`      | 262,144 | 65,536     | Default Step Plan model    |
| `stepfun-plan/step-3.5-flash-2603` | 262,144 | 65,536     | Additional Step Plan model |

## Image generation

Both provider ids also register the bundled
[`image_generate`](/tools/image-generation) tool. Use provider-prefixed model
refs so OpenClaw routes to the matching endpoint family.

| Provider surface | Model ref                        | Endpoint family              | Notes                                   |
| ---------------- | -------------------------------- | ---------------------------- | --------------------------------------- |
| Standard         | `stepfun/step-image-edit-2`      | Region-matched standard URL  | Generate + edit; 1 output; 1 input edit |
| Step Plan        | `stepfun-plan/step-image-edit-2` | Region-matched Step Plan URL | Generate + edit; 1 output; 1 input edit |

- Standard image calls use `/images/generations` and `/images/edits` under the
  standard StepFun base URL.
- Step Plan image calls use the same `/images/generations` and
  `/images/edits` paths under the Step Plan base URL.
- Supported StepFun image sizes are `1024x1024`, `768x1360`, `896x1184`,
  `1360x768`, and `1184x896`.
- OpenClaw currently exposes StepFun image generation with `response_format:
"b64_json"` and one reference image for edit mode, matching the StepFun
  image API constraints documented for `step-image-edit-2`.

## Getting started

Choose your provider surface and follow the setup steps.

<Tabs>
  <Tab title="Standard">
    **Best for:** general-purpose use via the standard StepFun endpoint.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice                      | Endpoint                         | Region        |
        | -------------------------------- | -------------------------------- | ------------- |
        | `stepfun-standard-api-key-intl`  | `https://api.stepfun.ai/v1`     | International |
        | `stepfun-standard-api-key-cn`    | `https://api.stepfun.com/v1`    | China         |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-intl
        ```

        Or for the China endpoint:

        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-cn
        ```
      </Step>
      <Step title="Non-interactive alternative">
        ```bash
        openclaw onboard --auth-choice stepfun-standard-api-key-intl \
          --stepfun-api-key "$STEPFUN_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider stepfun
        ```
      </Step>
    </Steps>

    ### Model refs

    - Default model: `stepfun/step-3.5-flash`

  </Tab>

  <Tab title="Step Plan">
    **Best for:** Step Plan reasoning endpoint.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice                  | Endpoint                                | Region        |
        | ---------------------------- | --------------------------------------- | ------------- |
        | `stepfun-plan-api-key-intl`  | `https://api.stepfun.ai/step_plan/v1`  | International |
        | `stepfun-plan-api-key-cn`    | `https://api.stepfun.com/step_plan/v1` | China         |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-intl
        ```

        Or for the China endpoint:

        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-cn
        ```
      </Step>
      <Step title="Non-interactive alternative">
        ```bash
        openclaw onboard --auth-choice stepfun-plan-api-key-intl \
          --stepfun-api-key "$STEPFUN_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider stepfun-plan
        ```
      </Step>
    </Steps>

    ### Model refs

    - Default model: `stepfun-plan/step-3.5-flash`
    - Alternate model: `stepfun-plan/step-3.5-flash-2603`

  </Tab>
</Tabs>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Full config: Standard provider">
    ```json5
    {
      env: { STEPFUN_API_KEY: "your-key" },
      agents: { defaults: { model: { primary: "stepfun/step-3.5-flash" } } },
      models: {
        mode: "merge",
        providers: {
          stepfun: {
            baseUrl: "https://api.stepfun.ai/v1",
            api: "openai-completions",
            apiKey: "${STEPFUN_API_KEY}",
            models: [
              {
                id: "step-3.5-flash",
                name: "Step 3.5 Flash",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Full config: Step Plan provider">
    ```json5
    {
      env: { STEPFUN_API_KEY: "your-key" },
      agents: { defaults: { model: { primary: "stepfun-plan/step-3.5-flash" } } },
      models: {
        mode: "merge",
        providers: {
          "stepfun-plan": {
            baseUrl: "https://api.stepfun.ai/step_plan/v1",
            api: "openai-completions",
            apiKey: "${STEPFUN_API_KEY}",
            models: [
              {
                id: "step-3.5-flash",
                name: "Step 3.5 Flash",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
              {
                id: "step-3.5-flash-2603",
                name: "Step 3.5 Flash 2603",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Notes">
    - The provider is bundled with OpenClaw, so there is no separate plugin install step.
    - `step-3.5-flash-2603` is currently exposed only on `stepfun-plan`.
    - A single auth flow writes region-matched profiles for both `stepfun` and `stepfun-plan`, so both surfaces can be discovered together.
    - Use `openclaw models list` and `openclaw models set <provider/model>` to inspect or switch models.

  </Accordion>
</AccordionGroup>

<Note>
For the broader provider overview, see [Model providers](/concepts/model-providers).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema for providers, models, and plugins.
  </Card>
  <Card title="Model selection" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="StepFun Platform" href="https://platform.stepfun.com" icon="globe">
    StepFun API key management and documentation.
  </Card>
</CardGroup>
