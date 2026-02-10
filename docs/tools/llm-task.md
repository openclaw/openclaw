---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "JSON-only LLM tasks for workflows (optional plugin tool)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a JSON-only LLM step inside workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need schema-validated LLM output for automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "LLM Task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# LLM Task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`llm-task` is an **optional plugin tool** that runs a JSON-only LLM task and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
returns structured output (optionally validated against JSON Schema).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is ideal for workflow engines like Lobster: you can add a single LLM step（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
without writing custom OpenClaw code for each workflow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable the plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
          "allowedModels": ["openai-codex/gpt-5.3-codex"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Tool parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Returns `details.json` containing the parsed JSON (and validates against（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`schema` when provided).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example: Lobster workflow step（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw.invoke --tool llm-task --action json --args-json '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "prompt": "Given the input email, return intent and draft.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "input": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "subject": "Hello",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "body": "Can you help?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "schema": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "object",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "properties": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "intent": { "type": "string" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "draft": { "type": "string" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "required": ["intent", "draft"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "additionalProperties": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The tool is **JSON-only** and instructs the model to output only JSON (no（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  code fences, no commentary).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No tools are exposed to the model for this run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat output as untrusted unless you validate with `schema`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Put approvals before any side-effecting step (send, post, exec).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
