# Fleet Orchestrator agent template

Files in this directory are copied into `~/.openclaw/agents/fleet-orchestrator/agent/` by the orchestrator extension's `install.ts` on first load. Operators can edit the live copy under `~/.openclaw/agents/` directly; the installer never overwrites an existing file.

| File                                    | Owner                 | Purpose                                                                                          |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `IDENTITY.md`                           | extension (template)  | Persona for the routing-only agent. Deliberately bare-bones — see the file for hard rules.       |
| `models.json`                           | operator (after init) | Provider + model config. **Not shipped here.** Created by `openclaw orchestrator init` (Unit 7). |
| `auth-profiles.json`, `auth-state.json` | runtime               | Created automatically when the agent first authenticates against its provider. Do not commit.    |

## Why no `models.json` template?

Models config carries provider API keys; shipping a template with placeholder strings produces silent boot failures and tempts operators to commit secrets. Unit 7's `openclaw orchestrator init` verb writes `models.json` with a cheap-but-instruction-following model (e.g. `google/gemma-4-31b-it`) and pulls the API key from the operator's existing OpenRouter credentials.

Until that verb ships, the Fleet Orchestrator agent will only function in `mode: "synthetic"` — no real `sessions_spawn` calls are made.
