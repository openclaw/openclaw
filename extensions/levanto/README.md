# Levanto Sage for OpenClaw

Official external plugin for native typed decisions with Levanto Sage. It
supports Boolean, Choice, Score, Sort, and Tags questions through OpenClaw's
prepared Decision V2 API. It does not provide chat completions.

## Setup

Requires OpenClaw `2026.11.5` or later. Each plugin release needs a host with
at least its own version; extended-stable `2026.10.x` hosts refuse the install.

Enable the plugin and connect a Levanto credential through the normal provider
connection flow:

```sh
openclaw models auth login --provider levanto
```

The common credential owner supports agent-scoped profiles and SecretRefs.
`LEVANTO_API_KEY` is the advertised environment source. Select
`levanto/levanto-sage` as the agent's `decisionModel`. Connecting a credential
does not select a model or schedule background work.

Evaluations send explicitly supplied evidence to Levanto and consume the
account's allowance. The adapter supports inline images for supported operations,
but does not enable grounding or perform implicit web searches. It retains
abstentions, partial batch errors, and reported usage without inventing cost.

See the [Levanto Sage guide](https://docs.openclaw.ai/providers/levanto) for
configuration, operation limits, billing, and result semantics.

## Live adapter test

From a matching source checkout, inject a Levanto-issued `LEVANTO_API_KEY`
through your secret manager, then run:

```sh
OPENCLAW_LIVE_TEST=1 node scripts/run-vitest.mjs --config test/vitest/vitest.live.config.ts extensions/levanto/registration.live.test.ts
```

The test makes five paid requests with reasoning off: four Boolean/Choice/Score/Tags
batches using synthetic text, PNG, JPEG, and WebP evidence, followed by one Sort
request. These requests consume the account's allowance and submit the synthetic
images to Levanto. It skips without both the opt-in flag and key.
It checks the registered V2 adapter and real transport, accepts native abstention,
and validates reported usage when present. Prepared credentials are fixture input;
the test does not exercise host credential discovery or change model selection.
