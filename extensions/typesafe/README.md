# TypeSafe AI for OpenClaw

Official external plugin for typed decisions with hosted TypeSafe AI Jev models
or a local Kev System One server.
It provides Choice, Score, and Boolean judgments through OpenClaw's shared
decision-model API. Core supplies the provider-neutral `decision_evaluate` agent
tool when the agent has an effective `decisionModel` selection, subject to normal
tool policy and harness capabilities. No separate tool enablement is required.

This adapter requires the prepared Decision V2 API. Released OpenClaw
`2026.10.4` exposes V1 only. For development, use a matching source checkout
containing the prepared V2 runtime and this plugin. Packaged use requires a
supporting paired host/plugin release; the older installation floor alone does
not establish V2 compatibility.

```sh
openclaw plugins install @openclaw/typesafe
```

The ClawHub install spec is `clawhub:@openclaw/typesafe`. First publication is
pending a supporting release. Enable the plugin, configure a protected TypeSafe credential, and select
`typesafe/jev-latest` as your agent's `decisionModel`. With that selection,
`decision_evaluate` sends supplied evidence to TypeSafe AI and incurs its normal
usage charges. Other providers route evidence according to their own configuration.

For local Kev, configure `plugins.entries.typesafe.config.baseUrl` with the
server's loopback origin, such as `http://127.0.0.1:8009`, omit `apiKey`, and select
`typesafe/kev-latest`. The plugin calls `/v1/systemone` without a hosted credential.
Start the server separately with your chosen checkpoint; the decision-model
selection labels requests and does not download or load a model.

For a separate inference host or HTTPS reverse proxy, use the standard
`models.providers.typesafe` configuration with `baseUrl`, optional `apiKey`,
`models: []`, and the shared `request` settings for auth, private-network policy,
proxy, and TLS. This route never inherits the legacy hosted plugin credential.
Evaluations send user content to the configured server; use HTTPS and select
a server you trust. Set the server's routing model ID as `decisionModel`.

See the [TypeSafe AI setup guide](https://docs.openclaw.ai/plugins/typesafe) and
[decision-model documentation](https://docs.openclaw.ai/concepts/decision-models)
for configuration, rubrics, and API semantics.

## Live adapter test

From a matching source checkout, inject a TypeSafe-issued `TYPESAFE_API_KEY`
through your secret manager, then run:

```sh
OPENCLAW_LIVE_TEST=1 node scripts/run-vitest.mjs --config test/vitest/vitest.live.config.ts extensions/typesafe/src/decisions.live.test.ts
```

The test sends two synthetic Boolean/Choice/Score batches (text and a generated
320 × 320 PNG) to hosted Jev and consumes the account's allowance. It skips without both the opt-in flag and key. It checks
the registered V2 adapter and real transport with an isolated prepared credential;
it does not test host credential discovery or change any model selection. When
HTTPS proxy environment settings are present, the test explicitly selects the
shared environment-proxy transport (including protected-key egress).
