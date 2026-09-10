---
summary: "Configuring providers from Settings -> Models, plugin-owned provider behavior, and API key rotation."
read_when:
  - You are adding or replacing provider keys in the Control UI
  - You want to know what provider plugins own
  - You are configuring multiple API keys or rotation
title: "Control UI and API keys"
---

## Configure providers in the Control UI

Open **Settings → Models** in the Control UI to add, replace, or remove provider API keys stored in `models.providers.<id>.apiKey`. The page identifies whether each API key comes from OpenClaw config or an environment variable without displaying the credential. Environment-provided keys remain managed by the gateway process environment.

Provider controls appear as soon as credentials, the model catalog, and configuration are ready. Usage and local costs load independently afterward, so a slow usage response does not block provider settings.

Open **Model Setup** from the page header to inspect detected AI access. When available, it shows the authentication method (API key or account sign-in) and the actual email address reported by the provider or local runtime. API keys and tokens stay hidden.

Use **Test connection** to run a live provider probe and see latency or a categorized authentication, rate-limit, billing, timeout, or response error. A probe makes a real provider request and may consume a small number of tokens. OAuth and token profiles can also be logged out from the provider card.

The **Defaults** card manages the primary model, utility model, first fallback, thinking level, and Fast mode from the configured model catalog. Changes save automatically to the existing `agents.defaults` settings. For the utility model, **Auto** leaves the setting unset and **Disabled** stores an empty string to turn utility routing off.

The fallback selector edits the first model in the ordered fallback chain. Replacing it preserves any later fallbacks already configured; selecting **No fallback model** clears the chain. Use `openclaw models fallbacks` to manage the full ordered list.

## Plugin-owned provider behavior

Most provider-specific logic lives in provider plugins (`registerProvider(...)`) while OpenClaw keeps the generic inference loop. Plugins own onboarding, model catalogs, auth env-var mapping, transport/config normalization, tool-schema cleanup, failover classification, OAuth refresh, usage reporting, thinking/reasoning profiles, and more.

The full list of provider-SDK hooks and bundled-plugin examples lives in [Provider plugins](/plugins/sdk-provider-plugins). A provider that needs a totally custom request executor is a separate, deeper extension surface.

<Note>
Provider-owned runner behavior lives on explicit provider hooks such as replay policy, tool-schema normalization, stream wrapping, and transport/request helpers. The legacy `ProviderPlugin.capabilities` static bag is compatibility-only and is no longer read by shared runner logic.
</Note>

## API key rotation

<AccordionGroup>
  <Accordion title="Key sources and priority">
    Configure multiple keys via:

    - `OPENCLAW_LIVE_<PROVIDER>_KEY` (single live override, highest priority)
    - `<PROVIDER>_API_KEYS` (comma or semicolon list)
    - `<PROVIDER>_API_KEY` (primary key)
    - `<PROVIDER>_API_KEY_*` (numbered list, e.g. `<PROVIDER>_API_KEY_1`)

    For Google providers, `GOOGLE_API_KEY` is also included as fallback. Key selection order preserves priority and deduplicates values.

  </Accordion>
  <Accordion title="When rotation kicks in">
    - Requests are retried with the next key only on rate-limit responses (for example `429`, `rate_limit`, `quota`, `resource exhausted`, `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, or periodic usage-limit messages).
    - Non-rate-limit failures fail immediately; no key rotation is attempted.
    - When all candidate keys fail, the final error is returned from the last attempt.

  </Accordion>
</AccordionGroup>
