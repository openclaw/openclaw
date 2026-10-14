---
summary: "Meta setup, authentication, and Muse Wonder and Muse Spark model selection"
title: "Meta"
read_when:
  - You want to use Meta with OpenClaw
  - You need the MODEL_API_KEY env var or CLI auth choice
---

The **Meta API** uses the OpenAI-compatible **Responses API** (`POST /v1/responses`)
for the Muse Wonder and Muse Spark reasoning models. OpenClaw provides Meta as an official external
plugin.

| Property                   | Value                              |
| -------------------------- | ---------------------------------- |
| Provider id                | `meta`                             |
| Plugin                     | `@openclaw/meta-provider`          |
| Auth env var               | `MODEL_API_KEY`                    |
| Onboarding flag            | `--auth-choice meta-api-key`       |
| Direct CLI flag            | `--meta-api-key <key>`             |
| API                        | Responses API (`openai-responses`) |
| Base URL                   | `https://api.meta.ai/v1`           |
| Default model              | `meta/muse-spark-1.3`              |
| OpenClaw reasoning default | `high` (`reasoning.effort`)        |

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/meta-provider
    ```

    Installation applies to a running Gateway automatically; otherwise it takes effect
    on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

  </Step>
  <Step title="Set the API key">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice meta-api-key
```

```bash Direct flag
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice meta-api-key \
  --meta-api-key "$MODEL_API_KEY"
```

```bash Env only
export MODEL_API_KEY=<key>
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider meta
    ```

    Lists the Meta catalog entries. Select `meta/muse-wonder-1.0` for Wonder. If `MODEL_API_KEY` is unresolved,
    `openclaw models status --json` reports the missing credential under
    `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice meta-api-key \
  --meta-api-key "$MODEL_API_KEY"
```

`--mode` defaults to `local`, so this is the same run as the **Direct flag**
command above. Run it on the Gateway host: remote-client onboarding
(`--mode remote`) only configures the local client connection and does not set
up provider credentials on the server.

## Built-in catalog

Prices and data-use terms come from Meta's
[pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits/)
documentation.
Meta's [model catalog](https://dev.meta.ai/docs/models) positions Muse Wonder for
complex coding and long-running agents, and Muse Spark for lower-cost workloads.
New setups keep Muse Spark 1.3 as their default; Wonder is an explicit selection.

| Model ref                         | Name                       | OpenClaw input | Reasoning | Context window | Input / cached input / output per 1M tokens |
| --------------------------------- | -------------------------- | -------------- | --------- | -------------- | ------------------------------------------- |
| `meta/muse-wonder-1.0`            | Muse Wonder                | text, image    | yes       | 1,048,576      | $4.00 / $0.20 / $20.00                      |
| `meta/muse-spark-1.3`             | Muse Spark 1.3             | text, image    | yes       | 1,048,576      | $1.25 / $0.15 / $4.25                       |
| `meta/muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | text, image    | yes       | 1,048,576      | $0.10 / $0.002 / $0.20                      |
| `meta/muse-spark-1.2`             | Muse Spark 1.2             | text, image    | yes       | 1,048,576      | $1.25 / $0.15 / $4.25                       |
| `meta/muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | text, image    | yes       | 1,048,576      | $0.10 / $0.002 / $0.20                      |
| `meta/muse-spark-1.1`             | Muse Spark 1.1             | text, image    | yes       | 1,048,576      | $1.25 / $0.15 / $4.25                       |

Muse Wonder is available in Standard mode only on Meta Model API. There is no
`muse-wonder-1.0-contributor` API model. **Muse Wonder Full**
(`muse-wonder-full-1.0`) is available only through the native Muse Code CLI on
Power Usage and Maximum Usage subscriptions, not through this API provider.
Setting Wonder's reasoning effort to `max` does not select Wonder Full. See
[Meta's availability table](https://dev.meta.ai/docs/models#muse-wonder-availability).

<Warning>
Meta's [pricing documentation](https://dev.meta.ai/docs/pricing-rate-limits/) and
[Terms of Service](https://dev.meta.ai/legal/terms-of-service) distinguish Standard
Services from Contributor/Discounted Services:

- Standard Services are the default. Meta says prompts and completions submitted to
  Standard Services are not used to train Meta models.
- By using Contributor/Discounted Services, you permit Meta to use Content submitted
  to and generated by those services as described in the Terms. Under the Terms, use
  of Discounted Services acknowledges that permission. You must not submit sensitive,
  confidential, or personal information to the Discounted Services.

Meta's [Geographic Use Policy](https://dev.meta.ai/legal/geographic-use-policy)
governs availability. It limits API access in some jurisdictions and adds end-user
deployment restrictions for products built with the Contributor/Discounted model;
those additional restrictions do not apply to your own use or products built with
Standard Services.
</Warning>

Capabilities:

- Text and image input through OpenClaw
- Tool calling and streaming
- Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh` (OpenClaw default: `high`)
- `max` effort for Muse Wonder and Muse Spark 1.3 Standard; not for Contributor models
- Stateless encrypted reasoning replay (`store: false`, `include: ["reasoning.encrypted_content"]`)

Meta's [model catalog](https://dev.meta.ai/docs/models) lists text, image, video,
audio, and PDF input for these models. OpenClaw's model catalog directly represents
text and image input only; the other upstream modalities are not model-manifest input
values.

OpenClaw uses a 131,072-token catalog output cap for these models. Meta does not
publish an exact maximum-output figure; this cap is not a claim about Meta's
maximum. Output tokens include both reasoning and visible text.

OpenClaw explicitly selects `high` when no thinking level is configured. This is an
OpenClaw default, not Meta's omitted-parameter behavior: Meta's
[reasoning documentation](https://dev.meta.ai/docs/reasoning/) says that when
`reasoning.effort` is omitted, the model reasons at a model-determined level.

<Warning>
Muse Wonder and Muse Spark do not accept `reasoning.effort: "none"`. OpenClaw maps
`--thinking off` to `minimal` for this provider.
</Warning>

## Manual config

```json5
{
  env: { vars: { MODEL_API_KEY: "<key>" } },
  agents: {
    defaults: {
      model: { primary: "meta/muse-wonder-1.0" },
      models: {
        "meta/muse-wonder-1.0": { alias: "Muse Wonder" },
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure
`MODEL_API_KEY` is available to that process — for example in
`~/.openclaw/.env` or through `env.shellEnv`. A key exported only in an
interactive shell will not help a managed service unless the env is imported
separately.
</Note>

## Smoke test

```bash
export MODEL_API_KEY=<key>
pnpm test:live -- extensions/meta/meta.live.test.ts
```

The live suite exercises enabled Meta cases against `POST /v1/responses`.
To test only Wonder, add `-t muse-wonder-1.0`. Its live cases cover text, image
input, reasoning effort, and a tool-call round trip with encrypted reasoning replay.

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Reasoning effort levels for Meta models.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
</CardGroup>
