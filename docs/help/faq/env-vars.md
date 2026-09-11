---
summary: "How OpenClaw loads environment variables and why service starts lose them"
title: "Env vars and .env loading"
read_when:
  - You are setting API keys through env or .env
  - Your env vars disappeared after starting the Gateway as a service
---

## Env vars and .env loading

<AccordionGroup>
  <Accordion title="How does OpenClaw load environment variables?">
    OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

    - `.env` from the current working directory.
    - a global fallback `.env` from `~/.openclaw/.env` (`$OPENCLAW_STATE_DIR/.env`).

    Normally, neither `.env` file overrides existing env vars. For an OpenClaw-installed systemd service, the global `.env` may replace only service values that OpenClaw recorded as managed; operator-owned service values still take precedence. Provider credential and endpoint-routing keys are an exception for workspace `.env`: keys such as `GEMINI_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, or any key ending in `_ENDPOINT` (and other bundled-provider auth or endpoint env vars) are ignored from workspace `.env` and should live in the process environment, `~/.openclaw/.env`, or config `env.vars`.

    Inline env vars in config apply only if missing from the process env:

    ```json5
    {
      env: {
        vars: {
          OPENROUTER_API_KEY: "sk-or-...",
          GROQ_API_KEY: "gsk-...",
        },
      },
    }
    ```

    See [/environment](/help/environment) for full precedence and sources.

  </Accordion>

  <Accordion title="I started the Gateway via the service and my env vars disappeared. What now?">
    Two fixes:

    1. Put the missing keys in `~/.openclaw/.env` so they load even when the service does not inherit your shell env.
    2. Enable shell import (opt-in convenience):
       ```json5
       {
         env: {
           shellEnv: {
             enabled: true,
             timeoutMs: 15000,
           },
         },
       }
       ```
       This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents: `OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

  </Accordion>

  <Accordion title='I set COPILOT_GITHUB_TOKEN, but models status shows "Shell env: off." Why?'>
    `openclaw models status` reports whether **shell env import** is enabled. "Shell env: off" does **not** mean your env vars are missing - it just means OpenClaw will not load your login shell automatically.

    If the Gateway runs as a service (launchd/systemd), it will not inherit your shell environment. Fix by putting the token in `~/.openclaw/.env`, enabling `env.shellEnv.enabled: true`, or adding it to config `env` (applies only if missing), then restarting the gateway and rechecking:

    ```bash
    openclaw models status
    ```

    Copilot tokens resolve in this order: `OPENCLAW_GITHUB_TOKEN`, then `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`.

    See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

  </Accordion>
</AccordionGroup>
