---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Broadcast a WhatsApp message to multiple agents"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Configuring broadcast groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging multi-agent replies in WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: experimental（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Broadcast Groups"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Broadcast Groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Status:** Experimental  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Version:** Added in 2026.1.9（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Broadcast Groups enable multiple agents to process and respond to the same message simultaneously. This allows you to create specialized agent teams that work together in a single WhatsApp group or DM — all using one phone number.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current scope: **WhatsApp only** (web channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Broadcast groups are evaluated after channel allowlists and group activation rules. In WhatsApp groups, this means broadcasts happen when OpenClaw would normally reply (for example: on mention, depending on your group settings).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Use Cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Specialized Agent Teams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deploy multiple agents with atomic, focused responsibilities:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group: "Development Team"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - CodeReviewer (reviews code snippets)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - DocumentationBot (generates docs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - SecurityAuditor (checks for vulnerabilities)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - TestGenerator (suggests test cases)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each agent processes the same message and provides its specialized perspective.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Multi-Language Support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group: "International Support"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Agent_EN (responds in English)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Agent_DE (responds in German)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Agent_ES (responds in Spanish)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Quality Assurance Workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group: "Customer Support"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - SupportAgent (provides answer)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - QAAgent (reviews quality, only responds if issues found)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. Task Automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group: "Project Management"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - TaskTracker (updates task database)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - TimeLogger (logs time spent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ReportGenerator (creates summaries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Basic Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a top-level `broadcast` section (next to `bindings`). Keys are WhatsApp peer ids:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- group chats: group JID (e.g. `120363403215116621@g.us`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs: E.164 phone number (e.g. `+15551234567`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Result:** When OpenClaw would reply in this chat, it will run all three agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Processing Strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control how agents process messages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Parallel (Default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All agents process simultaneously:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "strategy": "parallel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363403215116621@g.us": ["alfred", "baerbel"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Sequential（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents process in order (one waits for previous to finish):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "strategy": "sequential",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363403215116621@g.us": ["alfred", "baerbel"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Complete Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "code-reviewer",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "name": "Code Reviewer",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "/path/to/code-reviewer",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": { "mode": "all" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "security-auditor",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "name": "Security Auditor",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "/path/to/security-auditor",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": { "mode": "all" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "docs-generator",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "name": "Documentation Generator",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "/path/to/docs-generator",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "sandbox": { "mode": "all" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "strategy": "parallel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363424282127706@g.us": ["support-en", "support-de"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "+15555550123": ["assistant", "logger"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How It Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Message Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Incoming message** arrives in a WhatsApp group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Broadcast check**: System checks if peer ID is in `broadcast`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **If in broadcast list**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - All listed agents process the message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Each agent has its own session key and isolated context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Agents process in parallel (default) or sequentially（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **If not in broadcast list**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Normal routing applies (first matching binding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: broadcast groups do not bypass channel allowlists or group activation rules (mentions/commands/etc). They only change _which agents run_ when a message is eligible for processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Isolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each agent in a broadcast group maintains completely separate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session keys** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Conversation history** (agent doesn't see other agents' messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace** (separate sandboxes if configured)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tool access** (different allow/deny lists)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Memory/context** (separate IDENTITY.md, SOUL.md, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Group context buffer** (recent group messages used for context) is shared per peer, so all broadcast agents see the same context when triggered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This allows each agent to have:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Different personalities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Different tool access (e.g., read-only vs. read-write)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Different models (e.g., opus vs. sonnet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Different skills installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example: Isolated Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In group `120363403215116621@g.us` with agents `["alfred", "baerbel"]`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Alfred's context:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session: agent:alfred:whatsapp:group:120363403215116621@g.us（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
History: [user message, alfred's previous responses]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Workspace: /Users/pascal/openclaw-alfred/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tools: read, write, exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Bärbel's context:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
History: [user message, baerbel's previous responses]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Workspace: /Users/pascal/openclaw-baerbel/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tools: read only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Best Practices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Keep Agents Focused（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Design each agent with a single, clear responsibility:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "DEV_GROUP": ["formatter", "linter", "tester"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
✅ **Good:** Each agent has one job  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
❌ **Bad:** One generic "dev-helper" agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Use Descriptive Names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Make it clear what each agent does:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "security-scanner": { "name": "Security Scanner" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "code-formatter": { "name": "Code Formatter" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "test-generator": { "name": "Test Generator" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Configure Different Tool Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Give agents only the tools they need:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "reviewer": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "tools": { "allow": ["read", "exec"] } // Read-only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "fixer": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. Monitor Performance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With many agents, consider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Using `"strategy": "parallel"` (default) for speed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Limiting broadcast groups to 5-10 agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Using faster models for simpler agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5. Handle Failures Gracefully（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents fail independently. One agent's error doesn't block others:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Result: Agent A and C respond, Agent B logs error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Broadcast groups currently work with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ✅ WhatsApp (implemented)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🚧 Telegram (planned)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🚧 Discord (planned)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🚧 Slack (planned)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Broadcast groups work alongside existing routing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "bindings": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "agentId": "alfred"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "GROUP_B": ["agent1", "agent2"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GROUP_A`: Only alfred responds (normal routing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GROUP_B`: agent1 AND agent2 respond (broadcast)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Precedence:** `broadcast` takes priority over `bindings`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agents Not Responding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Agent IDs exist in `agents.list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Peer ID format is correct (e.g., `120363403215116621@g.us`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Agents are not in deny lists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Debug:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tail -f ~/.openclaw/logs/gateway.log | grep broadcast（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Only One Agent Responding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Cause:** Peer ID might be in `bindings` but not `broadcast`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix:** Add to broadcast config or remove from bindings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Performance Issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**If slow with many agents:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reduce number of agents per group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use lighter models (sonnet instead of opus)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check sandbox startup time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example 1: Code Review Team（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "strategy": "parallel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "120363403215116621@g.us": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "code-formatter",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "security-scanner",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "test-coverage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "docs-checker"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "code-formatter",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/agents/formatter",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": { "allow": ["read", "write"] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "security-scanner",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/agents/security",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": { "allow": ["read", "exec"] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "test-coverage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "workspace": "~/agents/testing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": { "allow": ["read", "exec"] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**User sends:** Code snippet  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Responses:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- code-formatter: "Fixed indentation and added type hints"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- security-scanner: "⚠️ SQL injection vulnerability in line 12"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- test-coverage: "Coverage is 45%, missing tests for error cases"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- docs-checker: "Missing docstring for function `process_data`"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example 2: Multi-Language Support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "broadcast": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "strategy": "sequential",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "+15555550123": ["detect-language", "translator-en", "translator-de"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { "id": "translator-en", "workspace": "~/agents/translate-en" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { "id": "translator-de", "workspace": "~/agents/translate-de" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## API Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config Schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
interface OpenClawConfig {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  broadcast?: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    strategy?: "parallel" | "sequential";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    [peerId: string]: string[];（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `strategy` (optional): How to process agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"parallel"` (default): All agents process simultaneously（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"sequential"`: Agents process in array order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `[peerId]`: WhatsApp group JID, E.164 number, or other peer ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Value: Array of agent IDs that should process messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Max agents:** No hard limit, but 10+ agents may be slow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Shared context:** Agents don't see each other's responses (by design)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Message ordering:** Parallel responses may arrive in any order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Rate limits:** All agents count toward WhatsApp rate limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Future Enhancements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Planned features:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Shared context mode (agents see each other's responses)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Agent coordination (agents can signal each other)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Dynamic agent selection (choose agents based on message content)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Agent priorities (some agents respond before others)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Multi-Agent Configuration](/tools/multi-agent-sandbox-tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Routing Configuration](/channels/channel-routing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Session Management](/concepts/sessions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
