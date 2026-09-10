---
summary: "Codex app-server model discovery, offline hints, and catalog rules"
read_when:
  - You are debugging the Codex model picker
  - You need the offline fallback model hints
  - You are pointing Codex at a custom catalog or broker
title: "Codex model discovery"
sidebarTitle: "Model discovery"
---

How the Codex model catalog is discovered, and what happens when discovery fails. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Model discovery

By default, the Codex plugin asks the app-server for available models. Model
availability is owned by Codex app-server, so the list can change when
OpenClaw upgrades the bundled `@openai/codex` version or when a deployment
points `appServer.command` at a different Codex binary. Availability can also
be account-scoped. Use `/codex models` on a running gateway to see the live
catalog for that harness and account.

Automatic discovery and hosted-search model selection use visible picker entries.
Bounded turns with an explicit model selection, including image understanding,
structured extraction, isolated completion, and settled-turn finalization, also
look up hidden entries returned by `model/list`. The model must still be listed
and support the required input modalities. Listing does not prove account
entitlement.

Native discovery reads `model/list` and `account/read` from the same scoped
app-server client. An API-key account remains API-key authentication; model
listing does not imply a ChatGPT transport or endpoint. Picker readiness is
valid only while that native owner and its account/config observation remain
current. A missing account, failed refresh, account/config mutation, or retired
client leaves native models unavailable until discovery succeeds again.

Use the Models page **Refresh** action (`models.list` with `view: "all"` and
`refresh: true`) to publish the full catalog for the selected agent. Prepared-only
reads do not start discovery. Native configuration changes outside OpenClaw
require the native owner's supported reload/restart and a catalog refresh;
OpenClaw does not poll native home files for readiness. Authored host routes and
explicit profile selections retain their existing auth and compatibility checks.

Native catalog identifiers are runtime identifiers, not privacy labels. A
deployment using a broker-owned alias must supply an alias-safe native catalog
before starting app-server: both `id` and `model` in `model/list` must be the
alias, with the desired `displayName`. Different native runtime identifiers are
preserved in OpenClaw model parameters. Renaming the picker label does not hide
those identifiers from requests or session state.

Codex's startup `model_catalog_json` setting can supply a native catalog; a
per-thread override does not reload it. Preserve the complete model capability,
instruction, compaction, and reviewer metadata. Catalog membership does not
reject arbitrary model overrides, so the broker must enforce allowed selectors
on every request. Disable native session discovery with
`sessionCatalog.enabled: false` when no native history should be imported.

A custom endpoint is not automatically a supported Codex route. Explicit
`agentRuntime.id: "codex"` does not bypass prepared-route compatibility or the
trusted-endpoint requirement for model-backed approval review. A workload API
key also does not provide ChatGPT account identity or subscription refresh.
Verify those contracts before using a broker with the native harness; do not
substitute a custom provider, remove safety metadata, or weaken review to make
an inference smoke test pass.

If discovery is temporarily unavailable or times out, the subscription route
uses offline hints derived from the bundled OpenAI model manifest, with Codex
plugin fallbacks for `gpt-5.5` and `gpt-5.5-pro` reasoning efforts:

| Model id      | Display name | Reasoning efforts             |
| ------------- | ------------ | ----------------------------- |
| `gpt-5.6-sol` | GPT-5.6 Sol  | low, medium, high, xhigh, max |
| `gpt-5.5`     | GPT-5.5      | low, medium, high, xhigh      |
| `gpt-5.5-pro` | gpt-5.5-pro  | medium, high, xhigh           |

Offline hints never prove account entitlement. An authenticated discovery
response remains authoritative even if it contains no visible models; HTTP
`401` and `403` return an empty catalog rather than exposing fallback models.

<Note>
The current bundled harness is `@openai/codex` `0.153.4`. A live `model/list`
probe against the official `0.153.4` app-server, using an isolated,
unauthenticated Codex home and `includeHidden: true`, returned this public
subset of catalog metadata:

| Model id        | Input modalities | Reasoning efforts                    |
| --------------- | ---------------- | ------------------------------------ |
| `gpt-5.4`       | text, image      | low, medium, high, xhigh             |
| `gpt-5.4-mini`  | text, image      | low, medium, high, xhigh             |
| `gpt-5.5`       | text, image      | low, medium, high, xhigh             |
| `gpt-5.6-luna`  | text, image      | low, medium, high, xhigh, max        |
| `gpt-5.6-sol`   | text, image      | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | text, image      | low, medium, high, xhigh, max, ultra |

The probe marked `gpt-5.4` and `gpt-5.4-mini` as hidden. This snapshot does not
prove account entitlement. Available model IDs, input modalities, and reasoning
efforts remain account-scoped. Run `/codex models` after starting or upgrading
the gateway to inspect the actual public picker for your account.

OpenClaw reasoning controls preserve supported native levels, including `ultra`.
Codex owns Ultra's proactive delegation and model-specific inference effort;
Platform API effort metadata does not downgrade the selected runtime mode.
Hidden models can also appear in the app-server catalog for internal or
specialized flows without being normal model-picker choices.
</Note>

Tune discovery under `plugins.entries.codex.config.discovery`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: true,
            timeoutMs: 2500,
          },
        },
      },
    },
  },
}
```

Disable discovery when you want startup to avoid probing Codex and use only
the fallback catalog:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: false,
          },
        },
      },
    },
  },
}
```
