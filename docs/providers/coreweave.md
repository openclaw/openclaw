---
summary: "CoreWeave Inference setup with the external provider plugin"
read_when:
  - You want to use CoreWeave Serverless Inference in OpenClaw
  - You want to authenticate with a Weights & Biases API key
title: "CoreWeave Inference"
---

CoreWeave Serverless Inference (formerly Weights & Biases Inference) serves
open models through an OpenAI-compatible API. The vendor-maintained
[`@coreweave/serverless-inference`](https://github.com/coreweave/serverless-inference-openclaw-plugin)
plugin supplies authentication, model discovery, and the model catalog.

| Property        | Value                                    |
| --------------- | ---------------------------------------- |
| Provider id     | `coreweave`                              |
| Auth env var    | `COREWEAVE_API_KEY`                      |
| Onboarding flag | `--auth-choice coreweave-api-key`        |
| API             | OpenAI-compatible (`openai-completions`) |
| Base URL        | `https://api.inference.wandb.ai/v1`      |
| Default model   | `coreweave/moonshotai/Kimi-K2.6`         |

## Install and authenticate

The published `0.1.1` plugin requires OpenClaw `2026.9.6` or newer.
Get a Weights & Biases API key at [wandb.ai/authorize](https://wandb.ai/authorize),
then install the plugin and run onboarding:

```bash
openclaw plugins install clawhub:@coreweave/serverless-inference
openclaw gateway restart
openclaw onboard --auth-choice coreweave-api-key
```

For app setup, choose CoreWeave in the API-key picker, enter your W&B API key,
and choose **Connect**. If the plugin is missing, complete the
installation and capability approvals before verification and activation.

## Select a model

List the provider's models and explicitly select a default:

```bash
openclaw models list --provider coreweave --refresh
openclaw models set coreweave/moonshotai/Kimi-K2.6
```

Model references use `coreweave/<vendor>/<model>`. Onboarding preserves an
existing default model, so use `models set` when switching from another provider.

The plugin filters its bundled catalog by IDs returned from the authenticated
`/models` endpoint. Discovery results are cached for five minutes. If discovery
fails or returns no rows, the plugin uses its bundled catalog. New IDs without
bundled metadata are skipped; update the plugin to pick up catalog changes.

## Optional project attribution

To attribute usage to a specific W&B team and project, set the plugin's `project`
option to `team/project`:

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

This adds the `openai-project` header to inference and model-discovery requests.

## Related

- [Model providers](/concepts/model-providers)
- [Models CLI](/cli/models)
- [Manage plugins](/plugins/manage-plugins)
