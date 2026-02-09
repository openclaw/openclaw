---
summary: "Mag-broadcast ng mensahe sa WhatsApp sa maraming agent"
read_when:
  - Pagko-configure ng broadcast groups
  - Pag-debug ng mga sagot ng maraming agent sa WhatsApp
status: experimental
title: "Broadcast Groups"
---

# Broadcast Groups

**Status:** Experimental  
**Version:** Idinagdag sa 2026.1.9

## Overview

Broadcast Groups enable multiple agents to process and respond to the same message simultaneously. This allows you to create specialized agent teams that work together in a single WhatsApp group or DM — all using one phone number.

Kasalukuyang saklaw: **WhatsApp lamang** (web channel).

Broadcast groups are evaluated after channel allowlists and group activation rules. In WhatsApp groups, this means broadcasts happen when OpenClaw would normally reply (for example: on mention, depending on your group settings).

## Use Cases

### 1. Specialized Agent Teams

Mag-deploy ng maraming agent na may atomic at nakatutok na mga responsibilidad:

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

Pinoproseso ng bawat agent ang parehong mensahe at nagbibigay ng kani-kanilang specialized na perspektibo.

### 2. Multi-Language Support

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. Quality Assurance Workflows

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. Task Automation

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Configuration

### Basic Setup

Add a top-level `broadcast` section (next to `bindings`). Keys are WhatsApp peer ids:

- group chats: group JID (hal. `120363403215116621@g.us`)
- DMs: E.164 phone number (hal. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Resulta:** Kapag sasagot sana ang OpenClaw sa chat na ito, tatakbo ang lahat ng tatlong agent.

### Processing Strategy

Kontrolin kung paano pinoproseso ng mga agent ang mga mensahe:

#### Parallel (Default)

Sabay-sabay na nagpoproseso ang lahat ng agent:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Sequential

Pinoproseso ng mga agent nang sunod-sunod (maghihintay ang isa hanggang matapos ang nauna):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Complete Example

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## How It Works

### Message Flow

1. **Papasok na mensahe** ay dumarating sa isang WhatsApp group
2. **Broadcast check**: Sinusuri ng system kung ang peer ID ay nasa `broadcast`
3. **Kung nasa broadcast list**:
   - Lahat ng nakalistang agent ay magpoproseso ng mensahe
   - Bawat agent ay may sariling session key at isolated na context
   - Ang mga agent ay nagpoproseso nang parallel (default) o sequential
4. **Kung wala sa broadcast list**:
   - Nalalapat ang normal na routing (unang tumugmang binding)

Note: broadcast groups do not bypass channel allowlists or group activation rules (mentions/commands/etc). They only change _which agents run_ when a message is eligible for processing.

### Session Isolation

Ang bawat agent sa isang broadcast group ay nagpapanatili ng ganap na magkakahiwalay na:

- **Session keys** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Conversation history** (hindi nakikita ng agent ang mga mensahe ng ibang agent)
- **Workspace** (hiwalay na mga sandbox kung naka-configure)
- **Tool access** (magkakaibang allow/deny list)
- **Memory/context** (hiwalay na IDENTITY.md, SOUL.md, atbp.)
- **Group context buffer** (mga kamakailang mensahe sa group na ginagamit bilang context) ay shared per peer, kaya nakikita ng lahat ng broadcast agent ang parehong context kapag na-trigger

Pinapahintulutan nito ang bawat agent na magkaroon ng:

- Magkakaibang personalidad
- Magkakaibang tool access (hal., read-only vs. read-write)
- Magkakaibang model (hal., opus vs. sonnet)
- Magkakaibang Skills na naka-install

### Example: Isolated Sessions

Sa group na `120363403215116621@g.us` na may mga agent na `["alfred", "baerbel"]`:

**Context ni Alfred:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Context ni Bärbel:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## Best Practices

### 1. Keep Agents Focused

Idisenyo ang bawat agent na may iisa at malinaw na responsibilidad:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Maganda:** Bawat agent ay may isang trabaho  
❌ **Hindi maganda:** Isang generic na "dev-helper" agent

### 2. Use Descriptive Names

Gawing malinaw kung ano ang ginagawa ng bawat agent:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. Configure Different Tool Access

Bigyan ang mga agent ng mga tool na talagang kailangan lang nila:

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. Monitor Performance

Kapag maraming agent, isaalang-alang ang:

- Paggamit ng `"strategy": "parallel"` (default) para sa bilis
- Paglilimita ng broadcast groups sa 5–10 agent
- Paggamit ng mas mabilis na model para sa mas simpleng agent

### 5. Handle Failures Gracefully

Agents fail independently. One agent's error doesn't block others:

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## Compatibility

### Providers

Kasalukuyang gumagana ang broadcast groups sa:

- ✅ WhatsApp (implemented)
- 🚧 Telegram (planned)
- 🚧 Discord (planned)
- 🚧 Slack (planned)

### Routing

Gumagana ang broadcast groups kasabay ng umiiral na routing:

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: Si alfred lang ang sasagot (normal routing)
- `GROUP_B`: agent1 AT agent2 ang sasagot (broadcast)

**Precedence:** Mas may prayoridad ang `broadcast` kaysa sa `bindings`.

## Troubleshooting

### Hindi Sumasagot ang mga Agent

**Suriin:**

1. Umiiral ang mga Agent ID sa `agents.list`
2. Tama ang format ng peer ID (hal., `120363403215116621@g.us`)
3. Ang mga agent ay wala sa deny lists

**Debug:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### Isang Agent Lang ang Sumasagot

**Sanhi:** Maaaring nasa `bindings` ang peer ID pero wala sa `broadcast`.

**Ayusin:** Idagdag sa broadcast config o alisin sa bindings.

### Mga Isyu sa Performance

**Kung mabagal kapag maraming agent:**

- Bawasan ang bilang ng mga agent bawat group
- Gumamit ng mas magagaan na model (sonnet sa halip na opus)
- Suriin ang oras ng pagsisimula ng sandbox

## Examples

### Example 1: Code Review Team

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**Nagpadala ang user:** Code snippet  
**Mga tugon:**

- code-formatter: "Inayos ang indentation at nagdagdag ng type hints"
- security-scanner: "⚠️ May SQL injection vulnerability sa linya 12"
- test-coverage: "45% ang coverage, kulang ang mga test para sa error cases"
- docs-checker: "Kulang ng docstring ang function na `process_data`"

### Example 2: Multi-Language Support

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## API Reference

### Config Schema

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Fields

- `strategy` (optional): Paano iproseso ang mga agent
  - `"parallel"` (default): Sabay-sabay na nagpoproseso ang lahat ng agent
  - `"sequential"`: Pinoproseso ng mga agent ayon sa pagkakasunod sa array
- `[peerId]`: WhatsApp group JID, E.164 number, o iba pang peer ID
  - Value: Array ng mga agent ID na dapat magproseso ng mga mensahe

## Limitations

1. **Max agents:** Walang hard limit, pero maaaring bumagal kapag 10+ agent
2. **Shared context:** Hindi nakikita ng mga agent ang mga sagot ng isa’t isa (ayon sa disenyo)
3. **Message ordering:** Maaaring dumating ang mga parallel na sagot sa anumang pagkakasunod
4. **Rate limits:** Lahat ng agent ay binibilang sa WhatsApp rate limits

## Future Enhancements

Mga planong feature:

- [ ] Shared context mode (nakikita ng mga agent ang mga sagot ng isa’t isa)
- [ ] Agent coordination (maaaring magsenyasan ang mga agent)
- [ ] Dynamic agent selection (pumili ng mga agent batay sa nilalaman ng mensahe)
- [ ] Agent priorities (may mga agent na sasagot bago ang iba)

## See Also

- [Multi-Agent Configuration](/tools/multi-agent-sandbox-tools)
- [Routing Configuration](/channels/channel-routing)
- [Session Management](/concepts/sessions)
