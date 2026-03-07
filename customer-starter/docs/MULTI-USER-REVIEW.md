# Multi-user context: what’s needed and where

Review of [MULTI-USER-CONTEXT.md](MULTI-USER-CONTEXT.md) and the main [Multi-User Context](https://docs.openclaw.ai/concepts/multi-user-context) doc. Goal: can everything be done in **openclaw-starter** so we don’t need to maintain a fork of OpenClaw?

---

## Checklist from the docs

| Requirement                                                                 | Implemented where                                         | In openclaw-starter?                    | OpenClaw code change? |
| --------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------- | --------------------- |
| **session.dmScope** (`per-peer`)                                            | OpenClaw core (session-key, resolve-route, config schema) | ✓ Config example has it                 | No                    |
| **session.identityLinks**                                                   | OpenClaw core (same)                                      | ✓ Config example has it                 | No                    |
| **users/ directory** in workspace                                           | Convention only; you create it or the agent does          | Doc + optional placeholder              | No                    |
| **Inject plugin** (read `users/<key>.md`, return `prependContext`)          | Not in OpenClaw; hook API exists, plugin missing          | ✓ Yes — add plugin, deploy to workspace | No                    |
| **plugins.allow** (include inject plugin)                                   | Config                                                    | ✓ Add to example                        | No                    |
| **AGENTS.md / SOUL.md** (instruct agent to write prefs to `users/<key>.md`) | Workspace files                                           | ✓ Snippet in openclaw-starter docs      | No                    |

---

## Conclusion

**All of it can be done in openclaw-starter. No OpenClaw repo code changes are required.**

- **Session routing** (dmScope, identityLinks) is already in OpenClaw; we only need config (already in the example).
- **Inject plugin:** The `before_agent_start` hook and `prependContext` are already in OpenClaw. The only missing piece is a small plugin that reads `users/<sanitized-session-key>.md` and returns that as `prependContext`. That plugin can live in openclaw-starter and be loaded by OpenClaw in either of two ways:
  1. **Workspace discovery:** Copy the plugin into the agent workspace at `workspace/.openclaw/extensions/user-context-inject/`. OpenClaw already discovers plugins there. Add `user-context-inject` to `plugins.allow` in config.
  2. **Config path:** Set `plugins.load.paths` in config to a path where the plugin lives (e.g. a directory you copy to the VM and mount). Add the plugin id to `plugins.allow`.

We use option 1 in this repo: the starter includes the plugin; you copy it into the workspace and add one line to config.

---

## What was added to openclaw-starter

1. **plugin/user-context-inject/** — The inject plugin (openclaw.plugin.json + index.ts). Copy this to your agent workspace’s `workspace/.openclaw/extensions/user-context-inject/` on the VM (or add its path to `plugins.load.paths` and ensure it’s on the container).
2. **Config** — Example snippet for `plugins.allow` (and optional `plugins.load.paths`) in [SETUP.md](../SETUP.md) and the config example.
3. **docs/AGENTS-SNIPPET-multi-user.md** — Snippet to paste into AGENTS.md or SOUL.md so the agent writes user preferences to `users/<key>.md`.
4. **SETUP Step 10** — Updated to reference the bundled plugin and the snippet.

You do **not** need a fork of OpenClaw for multi-user context or the inject plugin.
