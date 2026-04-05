# Mullusi (plugin)

Adds the `mullusi` agent tool as an **optional** plugin tool.

## What this is

- Mullusi is a standalone workflow shell (typed JSON-first pipelines + approvals/resume).
- This plugin integrates Mullusi with Mullusi _without core changes_.

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "mullusi" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    ]
  }
}
```

## Using `mullusi.invoke` (Mullusi → Mullusi tools)

Some Mullusi pipelines may include a `mullusi.invoke` step to call back into Mullusi tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).

For this to work, the Mullusi Gateway must expose the tool bridge endpoint and the target tool must be allowed by policy:

- Mullusi provides an HTTP endpoint: `POST /tools/invoke`.
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, Mullusi returns `404 Tool not available`.

### Allowlisting recommended

To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `mullusi.invoke`.

Example (allow only a small set of tools):

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["mullusi", "web_fetch", "web_search", "gog", "gh"],
          "deny": ["gateway"],
        },
      },
    ],
  },
}
```

Notes:

- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.
- Tool names depend on which plugins you have installed/enabled.

## Security

- Runs the `mullusi` executable as a local subprocess.
- Does not manage OAuth/tokens.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.
- Ensure `mullusi` is available on `PATH` for the gateway process.
