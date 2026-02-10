---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Models CLI: list, set, aliases, fallbacks, scan, status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing model fallback behavior or selection UX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating model scan probes (tools/images)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Models CLI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Models CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/concepts/model-failover](/concepts/model-failover) for auth profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rotation, cooldowns, and how that interacts with fallbacks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How model selection works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw selects models in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Primary** model (`agents.defaults.model.primary` or `agents.defaults.model`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Fallbacks** in `agents.defaults.model.fallbacks` (in order).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Provider auth failover** happens inside a provider before moving to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   next model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.models` is the allowlist/catalog of models OpenClaw can use (plus aliases).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.imageModel` is used **only when** the primary model can’t accept images.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent defaults can override `agents.defaults.model` via `agents.list[].model` plus bindings (see [/concepts/multi-agent](/concepts/multi-agent)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick model picks (anecdotal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GLM**: a bit better for coding/tool calling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **MiniMax**: better for writing and vibes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup wizard (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don’t want to hand-edit config, run the onboarding wizard:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It can set up model + auth for common providers, including **OpenAI Code (Codex)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
subscription** (OAuth) and **Anthropic** (API key recommended; `claude（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
setup-token` also supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config keys (overview)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.model.primary` and `agents.defaults.model.fallbacks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.imageModel.primary` and `agents.defaults.imageModel.fallbacks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.models` (allowlist + aliases + provider params)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models.providers` (custom providers written into `models.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to `zai/*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider configuration examples (including OpenCode Zen) live in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## “Model is not allowed” (and why replies stop)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session overrides. When a user selects a model that isn’t in that allowlist,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw returns:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model "provider/model" is not allowed. Use /model to list available models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This happens **before** a normal reply is generated, so the message can feel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
like it “didn’t respond.” The fix is to either:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add the model to `agents.defaults.models`, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clear the allowlist (remove `agents.defaults.models`), or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pick a model from `/model list`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example allowlist config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: { primary: "anthropic/claude-sonnet-4-5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic/claude-opus-4-6": { alias: "Opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Switching models in chat (`/model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can switch models for the current session without restarting:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model openai/gpt-5.2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model` (and `/model list`) is a compact, numbered picker (model family + available providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model <#>` selects from that picker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model status` is the detailed view (auth candidates and, when configured, provider endpoint `baseUrl` + `api` mode).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the model ID itself contains `/` (OpenRouter-style), you must include the provider prefix (example: `/model openrouter/moonshotai/kimi-k2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you omit the provider, OpenClaw treats the input as an alias or a model for the **default provider** (only works when there is no `/` in the model ID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full command behavior/config: [Slash commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set-image <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models aliases list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models aliases add <alias> <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models aliases remove <alias>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models fallbacks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models fallbacks add <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models fallbacks remove <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models fallbacks clear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models image-fallbacks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models image-fallbacks add <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models image-fallbacks remove <provider/model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models image-fallbacks clear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw models` (no subcommand) is a shortcut for `models status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shows configured models by default. Useful flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--all`: full catalog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--local`: local providers only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--provider <name>`: filter by provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--plain`: one model per line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine‑readable output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shows the resolved primary model, fallbacks, image model, and an auth overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
of configured providers. It also surfaces OAuth expiry status for profiles found（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
in the auth store (warns within 24h by default). `--plain` prints only the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resolved primary model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OAuth status is always shown (and included in `--json` output). If a configured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provider has no credentials, `models status` prints a **Missing auth** section.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(effective auth per provider).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preferred Anthropic auth is the Claude Code CLI setup-token (run anywhere; paste on the gateway host if needed):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
claude setup-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Scanning (OpenRouter free models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw models scan` inspects OpenRouter’s **free model catalog** and can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
optionally probe models for tool and image support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-probe`: skip live probes (metadata only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--min-params <b>`: minimum parameter size (billions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--max-age-days <days>`: skip older models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--provider <name>`: provider prefix filter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--max-candidates <n>`: fallback list size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--set-default`: set `agents.defaults.model.primary` to the first selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--set-image`: set `agents.defaults.imageModel.primary` to the first image selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Probing requires an OpenRouter API key (from auth profiles or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENROUTER_API_KEY`). Without a key, use `--no-probe` to list candidates only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scan results are ranked by:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Image support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Tool latency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Context size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Parameter count（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenRouter `/models` list (filter `:free`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires OpenRouter API key from auth profiles or `OPENROUTER_API_KEY` (see [/environment](/help/environment))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Probe controls: `--timeout`, `--concurrency`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When run in a TTY, you can select fallbacks interactively. In non‑interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mode, pass `--yes` to accept defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Models registry (`models.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Custom providers in `models.providers` are written into `models.json` under the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent directory (default `~/.openclaw/agents/<agentId>/models.json`). This file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is merged by default unless `models.mode` is set to `replace`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
