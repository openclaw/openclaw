# Sophia Module 2 runtime notes

This file covers the remaining Module 2 operational scope for Sophia in this repo and runtime setup.
It is not the notebook spec copied into the repo.

## What this pass completes

- Keeps the existing Sophia prompt files as the source of truth:
  - `sophia/AGENTS.md`
  - `sophia/tone_skills.md`
- Enables prompt injection of `tone_skills.md` through the bundled `bootstrap-extra-files` hook.
- Sets Sophia's timezone context to `Europe/Rome`.
- Configures web search for Brave with `llm-context` mode so the model receives compact grounded context rather than ordinary web snippets.
- Leaves Gmail as the already-working local integration.
- Defers calendar work.

## Runtime config shape

Apply the equivalent of this config in the runtime OpenClaw config used by Sophia:

```json5
{
  agents: {
    defaults: {
      userTimezone: "Europe/Rome",
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
      },
      fetch: {
        enabled: true,
      },
    },
  },
  plugins: {
    entries: {
      brave: {
        enabled: true,
        config: {
          webSearch: {
            mode: "llm-context",
          },
        },
      },
    },
  },
  hooks: {
    internal: {
      enabled: true,
      entries: {
        "bootstrap-extra-files": {
          enabled: true,
          paths: ["tone_skills.md"],
        },
      },
    },
  },
}
```

## Render deployment

The Brave API key should stay outside the repo.
Set this in the Render environment for the deployed gateway:

```bash
BRAVE_API_KEY=your-brave-search-key
```

Notes:

- Do not commit the API key into `openclaw.json`.
- `llm-context` mode is configured in OpenClaw, not in Render.
- After changing config or env on Render, restart the service so the gateway reloads the runtime config and provider env.

## Local Gmail status

Gmail is intentionally local-only in this pass and is already integrated in the local OpenClaw state/config.
Do not re-run Gmail onboarding unless you are repairing that integration.

## Why `tone_skills.md` needs the hook

OpenClaw auto-injects a fixed set of workspace bootstrap files by default.
`tone_skills.md` is not part of that default root list, so Sophia needs the `bootstrap-extra-files` hook to load it into `Project Context`.
Without that hook entry, the file can exist in the workspace and still never reach the model prompt automatically.

## Verification checklist

Run these after updating the runtime config:

1. Confirm timezone:
   ```bash
   pnpm openclaw config get agents.defaults.userTimezone
   ```
   Expected: `Europe/Rome`
2. Confirm web search provider:
   ```bash
   pnpm openclaw config get tools.web.search.provider
   ```
   Expected: `brave`
3. Confirm Brave `llm-context` mode:
   ```bash
   pnpm openclaw config get plugins.entries.brave.config.webSearch.mode
   ```
   Expected: `llm-context`
4. Confirm the bootstrap hook entry:
   ```bash
   pnpm openclaw config get hooks.internal.entries.bootstrap-extra-files.paths
   ```
   Expected to include `tone_skills.md`
5. Confirm the bundled hook is available:
   ```bash
   pnpm openclaw hooks info bootstrap-extra-files
   ```
6. Run targeted tests from the repo:
   ```bash
   pnpm test:fast -- src/agents/workspace.load-extra-bootstrap-files.test.ts src/hooks/bundled/bootstrap-extra-files/handler.test.ts src/agents/tools/web-tools.enabled-defaults.test.ts src/config/config.web-search-provider.test.ts
   ```

## Scope explicitly deferred

- Google Calendar
- Copying notebook spec text into the repo
- Moving Gmail from local integration to Render
