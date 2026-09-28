---
summary: "Use hosted Jev or a local System One server for typed decisions"
title: "TypeSafe AI"
read_when:
  - Configuring a typed decision model
  - Using TypeSafe with the decision evaluation tool
  - Running Kev locally through the System One API
---

# TypeSafe AI

The official external `typesafe` plugin connects OpenClaw's optional decision
model role to TypeSafe AI's hosted Jev models or an explicitly configured local
System One server such as [Kev](https://github.com/jaredpalmer/kev). Its models appear in the separate
**Decision** picker, never in the conversational model picker.

The adapter and decision model role were added after released OpenClaw
`2026.9.5`. Packaged installs require a host and plugin API of at least
`2026.9.6`; the installer rejects older hosts before loading the plugin.

See [Decision models](/concepts/decision-models) for the model role, available
backends, rubric examples, and provider-neutral plugin API.

The plugin is disabled by default. Installing or enabling it does not select a
decision model or schedule background work.

## Install

TypeSafe AI is packaged separately from core for publication to npm and
ClawHub. Its first publication is pending a supporting release. Once published,
install it from npm on a compatible host:

```sh
openclaw plugins install @openclaw/typesafe
```

To select ClawHub explicitly:

```sh
openclaw plugins install clawhub:@openclaw/typesafe
```

Until a supporting release is available, use a source checkout containing the
decision-provider API and `extensions/typesafe`. Build it with
`pnpm install --frozen-lockfile` and `pnpm build`, then apply the configuration
below. Source-checkout plugins use the host's co-versioned development API;
that does not make the packaged plugin compatible with OpenClaw `2026.9.5`.

## Enable and configure

For hosted Jev, create a protected credential in Settings → Secrets, then reference it from the
plugin configuration. Merge this example into your existing configuration; keep
any other entries in `plugins.allow`.

```json5
{
  plugins: {
    allow: ["typesafe"],
    entries: {
      typesafe: {
        enabled: true,
        config: {
          apiKey: { source: "store", provider: "default", id: "TYPESAFE_API_KEY" },
        },
      },
    },
  },
  agents: {
    ownership: "explicit",
    defaults: { decisionModel: "typesafe/jev-latest" },
    entries: {
      research: { decisionModel: "typesafe/jev-1.13.0" },
    },
  },
}
```

`typesafe/jev-latest` appears as **Jev**; the pinned
`typesafe/jev-1.13.0` appears as **Jev 1.13.0**. An unset agent override inherits
`agents.defaults.decisionModel`; an empty override disables decisions for that
agent. An unset or empty global role leaves decisions off by default.

Hosted mode reads the host's prepared SecretRef value for each request. It does
not independently read environment credentials or cache a previous credential.
A missing or unavailable credential makes decisions unavailable. Use the normal
[secret refresh flow](/gateway/secrets) after changing a credential.

Selecting a decision model authorizes supported, otherwise-enabled consumers to
send their selected evidence to the configured endpoint. Hosted Jev requests
incur TypeSafe's normal usage charges.
Consumer scheduling and publication permissions remain unchanged. Clearing the
role or explicitly disabling the plugin prevents its use by those consumers.

## Local System One server

### Run Kev

[Kev](https://github.com/jaredpalmer/kev) is an Apache-2.0 family of decision
models that serves the System One API through a persistent Python process.
It supports Apple Silicon and CUDA. The Qwen3-based Kev-0.6B, Kev-4B, and
Kev-8B checkpoints have been tested with this adapter.

For a Mac, start with the Qwen3-based Kev-4B checkpoint. This example requires
Python 3.12+ and [uv](https://docs.astral.sh/uv/), and pins the tested adapter
revision in a local directory. The first server start also downloads its base
model weights:

```sh
git clone https://github.com/jaredpalmer/kev.git
cd kev
git checkout 5f78968927069eaacc3b2bdb688586989b3933ac
uv sync --frozen --extra serve
uv run python - <<'PY'
from huggingface_hub import snapshot_download

snapshot_download(
    "jaredpalmer/kev-4b",
    revision="c4bfa11b0dc07691884f2d97f1c4c4c05c92e416",
    local_dir="models/kev-4b-qwen3",
)
PY
KEV_DTYPE=bf16 uv run --extra serve python -m kev.serve \
  --run models/kev-4b-qwen3 --port 8009
```

The newer default Kev-4B checkpoint uses Qwen3.5; its Mac performance differs
from the Qwen3 checkpoint above. Follow the upstream model cards when choosing
another checkpoint. Kev-0.6B uses less memory; Kev-8B trades more memory and
latency for decision quality. All of them use the same OpenClaw model label
for the server you configure below.

From the same Kev checkout in a second terminal, verify the loaded checkpoint
and run Kev's API tests:

```sh
curl --fail http://127.0.0.1:8009/v1/models
KEV_BASE_URL=http://127.0.0.1:8009 \
  uv run --extra serve python -m pytest tests/test_api.py -q
```

### Connect OpenClaw

Start your System One server separately, then set `baseUrl` to its loopback
origin and select `typesafe/kev-latest`:

```json5
{
  plugins: {
    allow: ["typesafe"],
    entries: {
      typesafe: {
        enabled: true,
        config: { baseUrl: "http://127.0.0.1:8009" },
      },
    },
  },
  agents: {
    defaults: { decisionModel: "typesafe/kev-latest" },
  },
}
```

Merge the example with existing settings, preserving other allowed plugins.
Omit `apiKey` for local inference. The plugin does not read or send the hosted
credential on this path; remove a retained SecretRef if the host should also
stop preparing it.

The endpoint applies to every request from this plugin, including requests
whose model label names Jev. Model selection does not choose between hosted and
local endpoints. The `kev-latest` label requires `baseUrl` and is never sent to
the hosted TypeSafe endpoint.

`baseUrl` accepts HTTP or HTTPS on `localhost`, `127.0.0.1`, or `[::1]`, with an
optional port and trailing slash. Supply the origin, without `/v1`, credentials,
query, or fragment; the plugin appends `/v1/systemone`. LAN and remote hosts are
not accepted. Ordinary ambient HTTP proxy variables are not used for these
requests; explicitly enabled managed proxy policy still applies.

Kev runs one checkpoint per server process. Its request model label does not
load or switch weights. Choose the checkpoint when starting the server and
inspect `GET /v1/models` to verify it. See Kev's [serving instructions](https://github.com/jaredpalmer/kev#quick-start)
for installation, model selection, and hardware requirements. OpenClaw does not
download weights or start that process. An unavailable server produces an
unavailable decision, without automatically switching to hosted Jev.

For lower latency, batch independent questions over the same state in one call.
Keep repeated evidence unchanged when possible so Kev can reuse its prefix
cache. The tested Kev server serializes inference; more concurrent HTTP calls
increase queueing time. Native decisions admit at most four concurrent requests
per provider and return `overloaded` beyond that limit. The core evaluation tool
uses the same admission limit.

Cancellation closes OpenClaw's HTTP request, but the Kev server may finish
inference already in progress. Avoid immediately resubmitting canceled work;
choose a deadline that allows for inference and queueing on your hardware.

For local compatibility, omitted question instructions are sent as `null`.
Structured Score rubric levels are encoded as text; returned legends must match
that transmitted rubric before the original level descriptions are restored in
decision results. Kev's optional nonnegative `latency_ms` field is validated and
removed; all answer types, labels, probabilities, and rubric bounds retain the
same validation as hosted results.

## Decision contract

Consumers call the provider-neutral
[decision runtime](/plugins/sdk-overview/capabilities#decision-models-contract-version-1).
The host supplies the model selected for the owning agent. The adapter translates
the supported question types:

| OpenClaw | TypeSafe | Result                                                       |
| -------- | -------- | ------------------------------------------------------------ |
| Choice   | Choice   | Reported label and probability estimates                     |
| Score    | Score    | Reported fractional zero-based rubric position and estimates |
| Boolean  | Noul     | Probability of true, preserved from 0 to 1                   |

Choice supports 2–255 alternatives; Score supports 2–10 rubric levels.
Unsupported input is rejected before transmission; the adapter does not truncate
or split a consumer's rubric. Responses must match the complete question batch,
its labels, types, and rubric bounds.

Reported probabilities can be rounded, so they may not sum exactly to one. A
reported label or Score can also differ from a calculation over those estimates.
OpenClaw preserves the returned values. Normalizing estimates or choosing their
largest value is an explicit consumer policy. Probabilities and confidence are
not demonstrated accuracy guarantees or permission to act.

The host owns concurrency, circuit health, deadlines, cancellation, and provider
lifecycle. Native decisions have a 30-second maximum; shorter consumer or
plugin timeouts still apply. Requests use the fixed TypeSafe HTTPS endpoint unless
`baseUrl` selects a local server. Both paths reject
redirects, and do not retry automatically. Consumers decide what to do with
unavailable decisions; caller cancellation must not start fallback work.

## Agent evaluation tool

Core provides `decision_evaluate` automatically when an agent has an effective
`decisionModel` selection. Normal [tool policy](/tools), including explicit denies,
and the active harness's capabilities still apply. No TypeSafe tool registration
or additional enablement setting is required. See the provider-neutral
[tool contract](/concepts/decision-models#agent-evaluation-tool) for its request
shape and results.

The tool accepts explicit shared `state` and independent `boolean`, `choice`, and
`score` questions. The calling agent's trusted identity selects its inherited or
per-agent `decisionModel`; there is no per-call provider or model override. With a
TypeSafe selection, the adapter translates Boolean questions to Noul and sends
only the supplied evidence to hosted Jev or the configured local endpoint.

A temporary credential or provider failure returns an actionable unavailable
result and leaves the configured tool available. Clearing the agent's effective
selection removes eligibility through the normal tool/context refresh lifecycle.
Execution rechecks the selection and current authority. `timeoutMs` defaults to
30,000 ms and caps provider requests at the shorter of this setting and the host's
remaining deadline. Typed answers supply evidence, not permission to publish,
send messages, or change durable state.

HTTP 413 (Content Too Large) and TypeSafe's [documented 422 request-validation
response](https://docs.typesafe.ai/api#errors) return `unsupported-input`, not a
provider outage. A 422 does not establish context overflow specifically. The
adapter cancels error bodies without reading them because they can reflect
credentials or submitted evidence. Authentication (401/403), rate limits (429),
and other HTTP/transport failures retain their existing classifications; no
automatic retry is added.

## Existing external installation

The official package keeps the `typesafe` plugin ID used by the prototype and
earlier development checkouts. Preserve `plugins.entries.typesafe`, its
protected credential, and agent `decisionModel` selections when switching.
Use the supported [plugin management flow](/plugins/manage-plugins) to replace
the old installation, and remove an explicit prototype path from
`plugins.load.paths` if it would override the installed package. Do not configure
two copies as independent providers. Installing the package does not delete
prototype files or credentials.
