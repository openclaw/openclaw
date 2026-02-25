---
summary: "Builder-API: Programmatisches Agent-Management für KI-Agenten"
read_when:
  - KI-Agenten sollen selbst Agents erstellen/deployen
  - Automatisierte Agent-Erstellung ohne Wizard
title: "Builder-API"
---

# Builder-API

Die Builder-API ermöglicht es **KI-Agenten**, programmatisch andere Agents zu erstellen, zu konfigurieren und zu deployen - **ohne den Wizard zu nutzen**.

## Anwendungsfall

**Szenario:** Ein KI-Agent soll selbstständig neue Agents erstellen und deployen.

```typescript
// Beispiel: KI-Agent erstellt einen neuen Agent
const gateway = new GatewayBrowserClient("ws://127.0.0.1:18789");

// 1. API-Key setzen (für den neuen Agent)
await gateway.request("builder.setApiKey", {
  provider: "anthropic",
  apiKey: "sk-ant-...",
});

// 2. Agent erstellen
const result = await gateway.request("builder.createAgent", {
  name: "assistant-agent",
  model: "claude-3-5-sonnet-20241022",
  identity: {
    emoji: "🤖",
    name: "Assistant Agent"
  }
});

// 3. Agent deployen (Konfiguration anwenden)
await gateway.request("builder.deployAgent", {
  agentId: result.agentId,
  config: {
    model: "claude-3-5-sonnet-20241022",
    skills: ["web-search", "code-execution"]
  }
});
```

## API-Methoden

### `builder.setApiKey`

Setzt einen API-Key für einen Provider (global oder agent-spezifisch).

**Parameter:**
- `provider` (string, required): Provider-Name (`"anthropic"`, `"openai"`, `"openrouter"`, `"google"`, etc.)
- `apiKey` (string, required): Der API-Key
- `profileId` (string, optional): Profil-ID (Standard: `"provider:default"`)
- `agentId` (string, optional): Agent-ID für agent-spezifische Keys

**Unterstützte Provider:**
- `anthropic` - Anthropic Claude
- `openrouter` - OpenRouter
- `google` / `gemini` - Google Gemini
- `openai` - OpenAI (via generisches Profil)
- Alle anderen Provider via generisches Profil

**Beispiel:**
```json
{
  "method": "builder.setApiKey",
  "params": {
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "agentId": "my-agent"  // Optional: agent-spezifisch
  }
}
```

### `builder.createAgent`

Erstellt einen neuen Agent programmatisch.

**Parameter:**
- `name` (string, required): Agent-Name
- `workspace` (string, optional): Workspace-Pfad (Standard: `~/.activi/workspace/{agentId}`)
- `model` (string, optional): Model-ID
- `emoji` (string, optional): Emoji für Identity
- `avatar` (string, optional): Avatar-URL
- `identity` (object, optional): Identity-Objekt mit `name`, `emoji`, `avatar`

**Beispiel:**
```json
{
  "method": "builder.createAgent",
  "params": {
    "name": "code-assistant",
    "model": "claude-3-5-sonnet-20241022",
    "identity": {
      "name": "Code Assistant",
      "emoji": "💻"
    }
  }
}
```

**Response:**
```json
{
  "ok": true,
  "agentId": "code-assistant",
  "name": "code-assistant",
  "workspace": "/Users/user/.activi/workspace/code-assistant"
}
```

### `builder.deployAgent`

Deployt Konfiguration für einen bestehenden Agent.

**Parameter:**
- `agentId` (string, required): Agent-ID
- `config` (object, optional): Konfiguration
  - `model` (string, optional): Model-ID
  - `tools` (string[], optional): Tool-IDs
  - `skills` (string[], optional): Skill-IDs

**Beispiel:**
```json
{
  "method": "builder.deployAgent",
  "params": {
    "agentId": "code-assistant",
    "config": {
      "model": "claude-3-5-sonnet-20241022",
      "skills": ["web-search", "code-execution"]
    }
  }
}
```

## Unterschied zum Wizard

| Feature | Wizard | Builder-API |
|---------|--------|-------------|
| **Zielgruppe** | Menschen (interaktiv) | KI-Agenten (programmatisch) |
| **UI** | Web-Dashboard / CLI | Gateway-API |
| **Flow** | 7-Schritt-Prozess | Einzelne API-Calls |
| **Use Case** | Ersteinrichtung | Automatisierte Erstellung |

## Sicherheit

Die Builder-API erfordert:
- Gateway-Authentifizierung (Token/Password)
- `operator.admin` Scope oder `admin` Role

## Beispiel: KI-Agent erstellt Team

```typescript
// KI-Agent erstellt ein 3-Agent-Team
const agents = ["dev", "qa", "prod"];

for (const agentName of agents) {
  // Agent erstellen
  const result = await gateway.request("builder.createAgent", {
    name: agentName,
    model: "claude-3-5-sonnet-20241022",
    identity: {
      name: `${agentName.toUpperCase()} Agent`,
      emoji: agentName === "dev" ? "💻" : agentName === "qa" ? "🧪" : "🚀"
    }
  });

  // Agent deployen
  await gateway.request("builder.deployAgent", {
    agentId: result.agentId,
    config: {
      model: "claude-3-5-sonnet-20241022",
      skills: ["web-search"]
    }
  });
}
```

## Siehe auch

- [Gateway-API](/gateway/api) - Allgemeine Gateway-API-Dokumentation
- [Agent-Management](/agents/management) - Agent-Verwaltung
- [Authentication](/gateway/authentication) - Authentifizierung
