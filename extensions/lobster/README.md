# Lobster (plugin)

Adds the `lobster` agent tool as an **optional** plugin tool.

## Install

```bash
openclaw plugins install @openclaw/lobster
```

Restart the Gateway after installing or updating the plugin.

## What this is

- Lobster is a standalone workflow shell (typed JSON-first pipelines + approval/input checkpoints).
- This plugin integrates Lobster with OpenClaw _without core changes_.
- Input checkpoints return the question and schema; resume with `responseJson` containing the user's answer as JSON. See [structured input](https://docs.openclaw.ai/tools/lobster#structured-input).

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "entries": {
      "main": {
        "default": true,
        "tools": {
          "allow": [
            "lobster" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    }
  }
}
```

## Using `openclaw.invoke` (Lobster → OpenClaw tools)

Some Lobster pipelines may include a `openclaw.invoke` step to call back into OpenClaw tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).

For this to work, the OpenClaw Gateway must expose the tool bridge endpoint and the target tool must be allowed by policy:

- OpenClaw provides an HTTP endpoint: `POST /tools/invoke`.
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, OpenClaw returns `404 Tool not available`.

### Allowlisting recommended

To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `openclaw.invoke`.

Example (allow only a small set of tools):

```jsonc
{
  "agents": {
    "entries": {
      "main": {
        "default": true,
        "tools": {
          "allow": ["lobster", "web_fetch", "web_search", "gog", "gh"],
          "deny": ["gateway"],
        },
      },
    },
  },
}
```

Notes:

- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.
- Tool names depend on which plugins you have installed/enabled.

## Embedded LLM stages

Use `llm.invoke --provider embedded --prompt 'Return a JSON object'` to request a tool-free completion through the host, without putting Gateway credentials in the workflow. This route requires a Gateway request and the calling agent supplied by the tool factory.

- No model specified: use the calling agent's configured primary and fallback models.
- Model specified: request a host-authorized override, pinned without fallbacks. A caller without override permission is refused before inference.
- Existing `openclaw`, `pi` and `http` routes remain remote routes. Provider auto-detection uses the final merged workflow and step environment; it never infers `embedded`.
- Embedded stages do not read or write persistent LLM cache/run-state answers. Refresh flags and step environment settings cannot enable reuse. Re-executing an embedded stage, including after an approval checkpoint, spends a new completion.
- A checkpoint that holds LLM stage output is authorized again before a resume returns or consumes it: the Gateway caller must still be current, and embedded output resumes only for the same agent and a caller still holding every operator scope the producing call held. A checkpoint with no plugin record is treated as holding a saved answer. Cancelling a checkpoint is not gated.
- Other routes retain their existing cache. Before returning a replay, the plugin requires a host authority checker, revalidates the current Gateway caller and refuses cancellation or revoked authority. This is Gateway authorization, not a new check against a remote provider's credential or model policy.
- The host background-completion API returns text only. The Lobster result does not report the actual selected model or token usage. This route does not expose per-stage sampling or output-token controls.

## Security

- Runs Lobster in process via the published `@clawdbot/lobster/core` runtime.
- Does not manage OAuth/tokens.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.

## Docs

- https://docs.openclaw.ai/tools/lobster

## Package

- Plugin id: `lobster`
- Tool: `lobster`
- Package: `@openclaw/lobster`
- Minimum OpenClaw host: `2026.4.25`
