# LLM Task (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Adds an **optional** agent tool `llm-task` for running **JSON-only** LLM tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(drafting, summarizing, classifying) with optional JSON Schema validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Designed to be called from workflow engines (for example, Lobster via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw.invoke --each`) without adding new OpenClaw code per workflow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Enable the plugin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "plugins": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "llm-task": { "enabled": true }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Allowlist the tool (it is registered with `optional: true`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": { "allow": ["llm-task"] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "plugins": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "llm-task": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "config": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "defaultProvider": "openai-codex",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "defaultModel": "gpt-5.2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "defaultAuthProfileId": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "allowedModels": ["openai-codex/gpt-5.2"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "maxTokens": 800,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "timeoutMs": 30000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`allowedModels` is an allowlist of `provider/model` strings. If set, any request（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
outside the list is rejected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompt` (string, required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `input` (any, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `schema` (object, optional JSON Schema)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `provider` (string, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` (string, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `authProfileId` (string, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `temperature` (number, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxTokens` (number, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutMs` (number, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Returns `details.json` containing the parsed JSON (and validates against（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`schema` when provided).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The tool is **JSON-only** and instructs the model to output only JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (no code fences, no commentary).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No tools are exposed to the model for this run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Side effects should be handled outside this tool (for example, approvals in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Lobster) before calling tools that send messages/emails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Bundled extension note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This extension depends on OpenClaw internal modules (the embedded agent runner).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is intended to ship as a **bundled** OpenClaw extension (like `lobster`) and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
be enabled via `plugins.entries` + tool allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is **not** currently designed to be copied into（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/extensions` as a standalone plugin directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
