# Lobster (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Adds the `lobster` agent tool as an **optional** plugin tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What this is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lobster is a standalone workflow shell (typed JSON-first pipelines + approvals/resume).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This plugin integrates Lobster with OpenClaw _without core changes_.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable it in an agent allowlist:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "allow": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "lobster" // plugin id (enables all tools from this plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Using `openclaw.invoke` (Lobster → OpenClaw tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some Lobster pipelines may include a `openclaw.invoke` step to call back into OpenClaw tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For this to work, the OpenClaw Gateway must expose the tool bridge endpoint and the target tool must be allowed by policy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw provides an HTTP endpoint: `POST /tools/invoke`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, OpenClaw returns `404 Tool not available`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allowlisting recommended（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `openclaw.invoke`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (allow only a small set of tools):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```jsonc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "allow": ["lobster", "web_fetch", "web_search", "gog", "gh"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "deny": ["gateway"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool names depend on which plugins you have installed/enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs the `lobster` executable as a local subprocess.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Does not manage OAuth/tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses timeouts, stdout caps, and strict JSON envelope parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer an absolute `lobsterPath` in production to avoid PATH hijack.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
