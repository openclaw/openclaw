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

The composer shows **Ultrafast** only when authenticated account discovery
advertises that service tier for the selected model, account, route, and runtime.
The OpenAI provider's existing account-scoped discovery supplies this observation;
static catalog hints and the native app-server's fallback list do not establish
access. Selecting a managed personal account prepares that account's catalog
through the same provider discovery path, without changing shared auth order.
Prepared-only reads do not start discovery. Account changes, failed discovery,
and retired generations cannot reuse another account's tier support.

Native-only accounts without managed discovery credentials, token-sharing auth
that cannot use model discovery, and catalogs without explicit service-tier
metadata leave this capability unknown. The composer hides Ultrafast in those
cases rather than offering a disabled option. Discovery support describes
availability, not a guarantee that an upstream request will receive that tier.

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
The current bundled harness is `@openai/codex` `0.159.1`. A `model/list`
probe against that app-server in an isolated, unauthenticated Codex home returned
these visible bundled catalog entries on September 29, 2026:

| Model id        | Input modalities | Reasoning efforts                    | Default effort |
| --------------- | ---------------- | ------------------------------------ | -------------- |
| `gpt-6.1-sol`   | text, image      | low, medium, high, xhigh, max, ultra | low            |
| `gpt-6-astra`   | text, image      | low, medium, high, xhigh, max, ultra | low            |
| `gpt-6-sol`     | text, image      | low, medium, high, xhigh, max, ultra | medium         |
| `gpt-6-luna`    | text, image      | low, medium, high, xhigh, max        | medium         |
| `gpt-5.6-sol`   | text, image      | low, medium, high, xhigh, max, ultra | low            |
| `gpt-5.6-terra` | text, image      | low, medium, high, xhigh, max, ultra | medium         |
| `gpt-5.6-luna`  | text, image      | low, medium, high, xhigh, max        | medium         |
| `gpt-5.5`       | text, image      | low, medium, high, xhigh             | medium         |

The same isolated probe with `0.158.0` did not list `gpt-6.1-sol`.
The new entry also advertises the `priority` service tier as Fast. This bundled
snapshot does not establish account access: authenticated catalogs can differ,
and native discovery still requires a current account. Run `/codex models`
after starting or upgrading the gateway to inspect the actual public picker
for your account. Existing configured model selections remain unchanged.

OpenClaw reasoning controls preserve supported native levels, including `ultra`.
Codex owns Ultra's proactive delegation and model-specific inference effort;
Platform API effort metadata does not downgrade the selected runtime mode.
Hidden models can also appear in the app-server catalog for internal or
specialized flows without being normal model-picker choices.
</Note>

Tune discovery under `plugins.entries.codex.config.discovery`:

The default budget is 10 seconds. It allows Codex's five-second remote catalog
refresh to finish or return its native cached/bundled catalog, with time left for
transport and the account read. Setting a shorter budget can cancel that native
fallback and leave native models unavailable until discovery succeeds.

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: true,
            timeoutMs: 10000,
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
