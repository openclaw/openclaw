---
summary: "Use CoreWeave Serverless Inference (formerly Weights & Biases Inference) in OpenClaw"
read_when:
  - You want open models served on CoreWeave GPUs in OpenClaw
  - You want CoreWeave Serverless Inference setup guidance
  - You are migrating from Weights & Biases Inference
title: "CoreWeave Serverless Inference"
---

CoreWeave Serverless Inference (formerly **Weights & Biases Inference**) serves popular open models on CoreWeave GPUs through an OpenAI-compatible API. Use your existing Weights & Biases account to authenticate.

## Why CoreWeave in OpenClaw

- **Open frontier models** such as Kimi, GLM, DeepSeek, Qwen, and Llama on CoreWeave infrastructure.
- **OpenAI-compatible** `/v1` endpoints, so OpenClaw talks to it like any OpenAI-style provider.
- **Vendor-prefixed model ids** (for example `coreweave/Qwen/Qwen3-235B-A22B-Instruct-2507`).
- **Refreshable catalog**: OpenClaw seeds a bundled catalog and refreshes it from the live `/models` endpoint.

## Getting started

<Steps>
  <Step title="Get your API key">
    1. Sign in at [wandb.ai/authorize](https://wandb.ai/authorize)
    2. Copy your API key
  </Step>
  <Step title="Configure OpenClaw">
    <Tabs>
      <Tab title="Interactive (recommended)">
        ```bash
        openclaw onboard --auth-choice coreweave-api-key
        ```

        This will:
        1. Prompt for your API key (or use existing `COREWEAVE_API_KEY`)
        2. Show all available CoreWeave models
        3. Let you pick your default model
        4. Configure the provider automatically
      </Tab>
      <Tab title="Environment variable">
        ```bash
        export COREWEAVE_API_KEY="your-key"
        ```
      </Tab>
      <Tab title="Non-interactive">
        ```bash
        openclaw onboard --non-interactive \
          --auth-choice coreweave-api-key \
          --coreweave-api-key "your-key"
        ```
      </Tab>
    </Tabs>

  </Step>
  <Step title="Verify setup">
    ```bash
    openclaw agent --model coreweave/moonshotai/Kimi-K2.6 --message "Hello, are you working?"
    ```
  </Step>
</Steps>

## Project attribution

Attribution is optional. CoreWeave Serverless Inference can attribute usage to a specific W&B team/project via an `openai-project` header. This is **optional** — if you omit it, W&B uses your default entity and a project named `inference`. Set it when you belong to more than one team or want usage attributed to a specific project, through the plugin config:

```json5
{
  plugins: {
    entries: {
      coreweave: {
        config: { project: "my-team/my-project" },
      },
    },
  },
}
```

When `project` is set, OpenClaw attaches `openai-project: team/project` to every request. When it is unset, no header is sent and W&B applies your default entity and the `inference` project.

## Model selection

After setup, OpenClaw shows all available CoreWeave models. Change your default any time:

```bash
openclaw models set coreweave/moonshotai/Kimi-K2.6
openclaw models set coreweave/zai-org/GLM-5.1
```

List all available models:

```bash
openclaw models list --all --provider coreweave
```

You can also run `openclaw configure`, select **Model/auth**, and choose **CoreWeave Serverless Inference**.

## Built-in catalog

OpenClaw ships a seed catalog and refreshes it from the live `/models` endpoint, falling back to the seed catalog if the API is unreachable. A current snapshot of generally available models:

| Model ID                                       | Name                         | Context | Features          |
| ---------------------------------------------- | ---------------------------- | ------- | ----------------- |
| `moonshotai/Kimi-K2.6`                         | Kimi K2.6 (default)          | 262k    | Reasoning, vision |
| `moonshotai/Kimi-K2.5`                         | Kimi K2.5                    | 262k    | Reasoning, vision |
| `zai-org/GLM-5.1`                              | GLM 5.1                      | 203k    | General           |
| `deepseek-ai/DeepSeek-V4-Pro`                  | DeepSeek V4 Pro              | 1M      | General           |
| `deepseek-ai/DeepSeek-V4-Flash`                | DeepSeek V4 Flash            | 1M      | General           |
| `deepseek-ai/DeepSeek-V3.1`                    | DeepSeek V3.1                | 161k    | Reasoning         |
| `Qwen/Qwen3-235B-A22B-Instruct-2507`           | Qwen3 235B A22B Instruct     | 262k    | General           |
| `Qwen/Qwen3-235B-A22B-Thinking-2507`           | Qwen3 235B A22B Thinking     | 262k    | Reasoning         |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct`          | Qwen3 Coder 480B             | 262k    | Coding, tools     |
| `Qwen/Qwen3-30B-A3B-Instruct-2507`             | Qwen3 30B A3B Instruct       | 262k    | General           |
| `Qwen/Qwen3.6-35B-A3B`                         | Qwen3.6 35B A3B              | 262k    | Vision            |
| `Qwen/Qwen3.6-27B`                             | Qwen3.6 27B                  | 262k    | Vision            |
| `Qwen/Qwen3.5-35B-A3B`                         | Qwen3.5 35B A3B              | 262k    | Vision            |
| `MiniMaxAI/MiniMax-M2.5`                       | MiniMax M2.5                 | 197k    | General           |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8` | NVIDIA Nemotron 3 Super 120B | 262k    | General           |
| `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`     | NVIDIA Nemotron 3 Ultra 550B | 262k    | General           |
| `openai/gpt-oss-120b`                          | GPT OSS 120B                 | 131k    | Reasoning         |
| `openai/gpt-oss-20b`                           | GPT OSS 20B                  | 131k    | Reasoning         |
| `google/gemma-4-31B-it`                        | Gemma 4 31B                  | 262k    | Vision            |
| `meta-llama/Llama-3.3-70B-Instruct`            | Llama 3.3 70B                | 128k    | General           |
| `meta-llama/Llama-3.1-70B-Instruct`            | Llama 3.1 70B                | 128k    | General           |
| `meta-llama/Llama-3.1-8B-Instruct`             | Llama 3.1 8B                 | 128k    | General           |
| `microsoft/Phi-4-mini-instruct`                | Phi 4 Mini                   | 128k    | General           |
| `ibm-granite/granite-4.1-8b`                   | Granite 4.1 8B               | 131k    | Tools             |
| `JetBrains/Mellum2-12B-A2.5B-Instruct`         | Mellum2 12B                  | 131k    | Tools             |
| `OpenPipe/Qwen3-14B-Instruct`                  | Qwen3 14B Instruct           | 32k     | General           |

The full, current list lives in the CoreWeave docs (see Related). Model availability changes over time; `openclaw models list --provider coreweave` reflects what the live endpoint reports.

## Pricing

CoreWeave Serverless Inference is billed through your Weights & Biases account. See [the W&B Inference pricing page](https://wandb.ai/site/inference/) for current rates.

## Troubleshooting

<AccordionGroup>
  <Accordion title="API key not recognized">
    ```bash
    echo $COREWEAVE_API_KEY
    openclaw models list | grep coreweave
    ```

    Get or rotate your key at [wandb.ai/authorize](https://wandb.ai/authorize).

  </Accordion>

  <Accordion title="Attributing usage to a team or project">
    Usage attribution is optional. Omit `project` to use your default entity and the `inference` project. If you belong to multiple teams or want usage attributed to a specific project, set the `project` plugin config to `team/project`. See [Project attribution](#project-attribution) above.
  </Accordion>

  <Accordion title="Connection issues">
    The endpoint is `https://api.inference.wandb.ai/v1`. Ensure your network allows HTTPS connections to that host.
  </Accordion>
</AccordionGroup>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Config file example">
    ```json5
    {
      env: { COREWEAVE_API_KEY: "..." },
      plugins: { entries: { coreweave: { config: { project: "my-team/my-project" } } } },
      agents: { defaults: { model: { primary: "coreweave/moonshotai/Kimi-K2.6" } } },
      models: {
        mode: "merge",
        providers: {
          coreweave: {
            baseUrl: "https://api.inference.wandb.ai/v1",
            apiKey: "${COREWEAVE_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "moonshotai/Kimi-K2.6",
                name: "Kimi K2.6",
                reasoning: false,
                input: ["text", "image"],
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
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="CoreWeave Serverless Inference" href="https://wandb.ai/site/inference/" icon="globe">
    Product overview and model lineup.
  </Card>
  <Card title="API documentation" href="https://docs.wandb.ai/inference" icon="book">
    Inference API reference and developer docs.
  </Card>
  <Card title="Get an API key" href="https://wandb.ai/authorize" icon="key">
    Create or rotate your access key.
  </Card>
</CardGroup>
