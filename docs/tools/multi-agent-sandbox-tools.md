---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Per-agent sandbox + tool restrictions, precedence, and examples"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Multi-Agent Sandbox & Tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: active（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Multi-Agent Sandbox & Tools Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each agent in a multi-agent setup can now have its own:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sandbox configuration** (`agents.list[].sandbox` overrides `agents.defaults.sandbox`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tool restrictions** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This allows you to run multiple agents with different security profiles:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Personal assistant with full access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Family/work agents with restricted tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Public-facing agents in sandboxes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`setupCommand` belongs under `sandbox.docker` (global or per-agent) and runs once（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
when the container is created.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth is per-agent: each agent reads from its own `agentDir` auth store at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/agents/<agentId>/agent/auth-profiles.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Credentials are **not** shared between agents. Never reuse `agentDir` across agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to share creds, copy `auth-profiles.json` into the other agent's `agentDir`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For how sandboxing behaves at runtime, see [Sandboxing](/gateway/sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For debugging “why is this blocked?”, see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) and `openclaw sandbox explain`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example 1: Personal + Restricted Family Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "default": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "name": "Personal Assistant",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": { "mode": "off" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "name": "Family Bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace-family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "mode": "all",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "scope": "agent"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "allow": ["read"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "bindings": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "agentId": "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "match": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "provider": "whatsapp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "accountId": "*",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "peer": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "kind": "group",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "id": "120363424282127706@g.us"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Result:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `main` agent: Runs on host, full tool access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `family` agent: Runs in Docker (one container per agent), only `read` tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example 2: Work Agent with Shared Sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace-personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": { "mode": "off" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace-work",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "mode": "all",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "scope": "shared",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "workspaceRoot": "/tmp/work-sandboxes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "allow": ["read", "write", "apply_patch", "exec"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "deny": ["browser", "gateway", "discord"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example 2b: Global coding profile + messaging-only agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tools": { "profile": "coding" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "support",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": { "profile": "messaging", "allow": ["slack"] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Result:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- default agents get coding tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `support` agent is messaging-only (+ Slack tool)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example 3: Different Sandbox Modes per Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mode": "non-main", // Global default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "scope": "session"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "mode": "off" // Override: main never sandboxed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "public",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace-public",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "mode": "all", // Override: public always sandboxed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "scope": "agent"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "allow": ["read"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "deny": ["exec", "write", "edit", "apply_patch"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration Precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When both global (`agents.defaults.*`) and agent-specific (`agents.list[].*`) configs exist:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sandbox Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agent-specific settings override global:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.mode > agents.defaults.sandbox.mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.scope > agents.defaults.sandbox.scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Notes:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].sandbox.{docker,browser,prune}.*` overrides `agents.defaults.sandbox.{docker,browser,prune}.*` for that agent (ignored when sandbox scope resolves to `"shared"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool Restrictions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The filtering order is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Tool profile** (`tools.profile` or `agents.list[].tools.profile`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Provider tool profile** (`tools.byProvider[provider].profile` or `agents.list[].tools.byProvider[provider].profile`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Global tool policy** (`tools.allow` / `tools.deny`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Provider tool policy** (`tools.byProvider[provider].allow/deny`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Agent-specific tool policy** (`agents.list[].tools.allow/deny`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Agent provider policy** (`agents.list[].tools.byProvider[provider].allow/deny`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **Sandbox tool policy** (`tools.sandbox.tools` or `agents.list[].tools.sandbox.tools`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. **Subagent tool policy** (`tools.subagents.tools`, if applicable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each level can further restrict tools, but cannot grant back denied tools from earlier levels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.list[].tools.profile` is set, it overrides `tools.profile` for that agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool groups (shorthands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool policies (global, agent, sandbox) support `group:*` entries that expand to multiple concrete tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:runtime`: `exec`, `bash`, `process`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:fs`: `read`, `write`, `edit`, `apply_patch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:memory`: `memory_search`, `memory_get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:ui`: `browser`, `canvas`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:automation`: `cron`, `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:messaging`: `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:nodes`: `nodes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:openclaw`: all built-in OpenClaw tools (excludes provider plugins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Elevated Mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.elevated` is the global baseline (sender-based allowlist). `agents.list[].tools.elevated` can further restrict elevated for specific agents (both must allow).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mitigation patterns:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deny `exec` for untrusted agents (`agents.list[].tools.deny: ["exec"]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid allowlisting senders that route to restricted agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable elevated globally (`tools.elevated.enabled: false`) if you only want sandboxed execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disable elevated per agent (`agents.list[].tools.elevated.enabled: false`) for sensitive profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Migration from Single Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Before (single agent):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "workspace": "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mode": "non-main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "allow": ["read", "write", "apply_patch", "exec"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "deny": []（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**After (multi-agent with different profiles):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "default": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/.openclaw/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": { "mode": "off" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy `agent.*` configs are migrated by `openclaw doctor`; prefer `agents.defaults` + `agents.list` going forward.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool Restriction Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Read-only Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "allow": ["read"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "deny": ["exec", "write", "edit", "apply_patch", "process"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Safe Execution Agent (no file modifications)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "allow": ["read", "exec", "process"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Communication-only Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common Pitfall: "non-main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.sandbox.mode: "non-main"` is based on `session.mainKey` (default `"main"`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
not the agent id. Group/channel sessions always get their own keys, so they（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are treated as non-main and will be sandboxed. If you want an agent to never（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sandbox, set `agents.list[].sandbox.mode: "off"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After configuring multi-agent sandbox and tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Check agent resolution:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw agents list --bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Verify sandbox containers:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   docker ps --filter "name=openclaw-sbx-"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Test tool restrictions:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Send a message requiring restricted tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Verify the agent cannot use denied tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Monitor logs:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agent not sandboxed despite `mode: "all"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check if there's a global `agents.defaults.sandbox.mode` that overrides it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent-specific config takes precedence, so set `agents.list[].sandbox.mode: "all"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tools still available despite deny list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check tool filtering order: global → agent → sandbox → subagent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each level can only further restrict, not grant back（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify with logs: `[tools] filtering tools for agent:${agentId}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Container not isolated per agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `scope: "agent"` in agent-specific sandbox config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default is `"session"` which creates one container per session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Multi-Agent Routing](/concepts/multi-agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Session Management](/concepts/session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
