---
summary: "Config format and location, restarts, web search, config.apply recovery, and browser control"
title: "Config basics"
read_when:
  - You are editing the config for the first time
  - You need web search, browser control, or config recovery
---

## Config basics

<AccordionGroup>
  <Accordion title="What format is the config? Where is it?">
    OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`). If the file is missing, it uses safe-ish defaults, including a default workspace of `~/.openclaw/workspace`.
  </Accordion>

  <Accordion title='I set gateway.bind: "lan" (or "tailnet") and now nothing listens / the UI says unauthorized'>
    Non-loopback binds **require a valid gateway auth path**: shared-secret auth (token or password), or `gateway.auth.mode: "trusted-proxy"` behind a correctly configured identity-aware reverse proxy.

    ```json5
    {
      gateway: {
        bind: "lan",
        auth: {
          mode: "token",
          token: "replace-me",
        },
      },
    }
    ```

    - `gateway.remote.token` / `.password` do **not** enable local gateway auth by themselves; local call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
    - For password auth, set `gateway.auth.mode: "password"` plus `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
    - If `gateway.auth.token` / `.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
    - Shared-secret Control UI setups authenticate via `connect.params.auth.token` or `connect.params.auth.password` (stored in app/UI settings). Identity-bearing modes such as Tailscale Serve or `trusted-proxy` use request headers instead - avoid putting shared secrets in URLs.
    - With `gateway.auth.mode: "trusted-proxy"`, same-host loopback reverse proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true` and a loopback entry in `gateway.trustedProxies`.

  </Accordion>

  <Accordion title="Why do I need a token on localhost now?">
    OpenClaw enforces gateway auth by default, including loopback. If no explicit auth path is configured, startup resolves to token mode and generates a runtime-only token for that startup, so local WS clients must authenticate. This blocks other local processes from calling the Gateway.

    On a fresh loopback start, the Gateway prepares the canonical same-user CLI device credential before `/readyz`, so normal `openclaw` CLI calls can authenticate without persisting the generated token. Other clients still need an explicit shared secret or an approved device pairing.

    Configure `gateway.auth.token`, `gateway.auth.password`, `OPENCLAW_GATEWAY_TOKEN`, or `OPENCLAW_GATEWAY_PASSWORD` explicitly when clients need a stable secret across restarts. You can also choose password mode, or `trusted-proxy` for identity-aware reverse proxies. For open loopback, set `gateway.auth.mode: "none"` explicitly. `openclaw doctor --generate-gateway-token` generates a token any time.

  </Accordion>

  <Accordion title="Do I have to restart after changing config?">
    The Gateway watches the config and supports hot-reload: `gateway.reload.mode: "hybrid"` (default) hot-applies safe changes and restarts for critical ones. `off` disables config reload; the earlier `hot` and `restart` modes are retired. Most `tools.*`, `agents.*` policy, `session.*`, and `messages.*` changes apply immediately with no reload action at all; `gateway.*` binding/port changes require a restart.
  </Accordion>

  <Accordion title="How do I enable web search (and web fetch)?">
    `web_fetch` works without an API key. `web_search` depends on your selected provider:

    | Provider | Key-free | Env var(s) |
    | --- | --- | --- |
    | Brave | No | `BRAVE_API_KEY` |
    | DuckDuckGo | Yes (unofficial HTML-based) | - |
    | Exa | No | `EXA_API_KEY` |
    | Firecrawl | No | `FIRECRAWL_API_KEY` |
    | Gemini | No | `GEMINI_API_KEY` |
    | Grok | No (xAI OAuth or key) | `XAI_API_KEY` |
    | Kimi | No | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
    | MiniMax Search | No | `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, or `MINIMAX_API_KEY` |
    | Ollama Web Search | Local: yes (needs `ollama signin`); hosted: no | Hosted: `OLLAMA_API_KEY` |
    | Perplexity | No | `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` |
    | SearXNG | Yes (self-hosted) | `SEARXNG_BASE_URL` |
    | Tavily | No | `TAVILY_API_KEY` |

    Grok can also reuse xAI OAuth from model auth (`openclaw onboard --auth-choice xai-oauth`).

    **Recommended**: `openclaw configure --section web` and pick a provider.

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "BRAVE_API_KEY_HERE",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
            maxResults: 5,
          },
          fetch: {
            enabled: true,
            provider: "firecrawl", // optional; omit for auto-detect
          },
        },
      },
    }
    ```

    Provider-specific web-search config lives under `plugins.entries.<plugin>.config.webSearch.*`. Legacy `tools.web.search.*` provider paths still load for compatibility but should not be used in new configs. Firecrawl web-fetch fallback config lives under `plugins.entries.firecrawl.config.webFetch.*`.

    - Allowlists: add `web_search`/`web_fetch`/`x_search`, or `group:web` for all three.
    - `web_fetch` is enabled by default.
    - If `tools.web.fetch.provider` is omitted, OpenClaw auto-detects the first ready fetch fallback provider from available credentials; the official Firecrawl plugin provides that fallback.
    - Daemons read env vars from `~/.openclaw/.env` (or the service environment).

    Docs: [Web tools](/tools/web).

  </Accordion>

  <Accordion title="config.apply wiped my config. How do I recover and avoid this?">
    `config.apply` replaces the **entire config**; a partial object removes everything else.

    Current OpenClaw protects most accidental clobbers:

    - OpenClaw-owned config writes validate the full post-change config before writing.
    - Invalid or destructive OpenClaw-owned writes are rejected and saved as `openclaw.json.rejected.*`.
    - Startup can migrate deterministic legacy keys in eligible single-file configs when the whole result validates, keeping the previous config in the `.bak` ring. Other invalid edits make startup fail closed; hot reload skips invalid edits without rewriting `openclaw.json`.
    - `openclaw doctor --fix` owns repairs beyond that startup migration, can restore last-known-good, and saves the rejected file as `openclaw.json.clobbered.*`.

    Recover:

    - Check `openclaw logs --follow` for `Invalid config at`, `Config write rejected:`, or `config reload skipped (invalid config)`.
    - Inspect the newest `openclaw.json.clobbered.*` or `openclaw.json.rejected.*` beside the active config.
    - Run `openclaw config validate` and `openclaw doctor --fix`.
    - Copy only the intended keys back with `openclaw config set` or `config.patch`.
    - No last-known-good or rejected payload: restore from backup, or re-run `openclaw doctor` and reconfigure channels/models.
    - Unexpected loss: file a bug with your last known config or a backup. A local coding agent can often reconstruct a working config from logs or history.

    Avoid it: use `openclaw config set` for small changes, `openclaw configure` for interactive edits, `config.schema.lookup` to inspect an unfamiliar path (returns a shallow schema node plus immediate child summaries), and `config.patch` for partial RPC edits - reserve `config.apply` for full-config replacement. The agent-facing `gateway` runtime tool refuses to rewrite `tools.exec.ask` / `tools.exec.security` even via legacy `tools.bash.*` aliases.

    Docs: [Config](/cli/config), [Configure](/cli/configure), [Gateway troubleshooting](/gateway/troubleshooting#gateway-rejected-invalid-config), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="How do I run a central Gateway with specialized workers across devices?">
    Common pattern: **one Gateway** (for example a Raspberry Pi) plus **nodes** and **agents**.

    - **Gateway (central)**: owns channels (Signal/WhatsApp), routing, sessions.
    - **Nodes (devices)**: Macs/iOS/Android connect as peripherals and expose local tools such as `system.run` and `camera`; Macs can also present hosted widgets in the native panel.
    - **Agents (workers)**: separate brains/workspaces for special roles (for example ops vs personal data).
    - **Sub-agents**: spawn background work from a main agent for parallelism.
    - **TUI**: connect to the Gateway and switch agents/sessions.

    Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

  </Accordion>

  <Accordion title="Can the OpenClaw browser run headless?">
    Yes:

    ```json5
    {
      browser: { headless: true },
      agents: {
        defaults: {
          sandbox: { browser: { headless: true } },
        },
      },
    }
    ```

    Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites (X/Twitter often blocks headless sessions). It uses the same Chromium engine and works for most automation; the main difference is no visible browser window (use screenshots for visuals). See [Browser](/tools/browser).

  </Accordion>

  <Accordion title="How do I use Brave for browser control?">
    Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway. See [Browser](/tools/browser/configuration#use-brave-or-another-chromium-based-browser).
  </Accordion>
</AccordionGroup>
