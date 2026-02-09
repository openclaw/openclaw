---
summary: "Een WhatsApp-bericht uitzenden naar meerdere agents"
read_when:
  - Broadcastgroepen configureren
  - Multi-agentreacties in WhatsApp debuggen
status: experimental
title: "Broadcastgroepen"
---

# Broadcastgroepen

**Status:** Experimenteel  
**Versie:** Toegevoegd in 2026.1.9

## Overzicht

Broadcastgroepen stellen meerdere agents in staat om hetzelfde bericht gelijktijdig te verwerken en te beantwoorden. Hiermee kun je gespecialiseerde agentteams maken die samenwerken in één WhatsApp-groep of DM — allemaal met één telefoonnummer.

Huidige scope: **alleen WhatsApp** (webkanaal).

Broadcastgroepen worden geëvalueerd na kanaal-allowlists en regels voor groepsactivatie. In WhatsApp-groepen betekent dit dat broadcasts plaatsvinden wanneer OpenClaw normaal gesproken zou antwoorden (bijvoorbeeld: bij een vermelding, afhankelijk van je groepsinstellingen).

## Use cases

### 1. Gespecialiseerde agentteams

Zet meerdere agents in met afgebakende, gerichte verantwoordelijkheden:

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

Elke agent verwerkt hetzelfde bericht en levert zijn gespecialiseerde perspectief.

### 2. Meertalige ondersteuning

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. Kwaliteitsborgingsworkflows

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. Taakautomatisering

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Configuratie

### Basisinstallatie

Voeg een top-level `broadcast`-sectie toe (naast `bindings`). Sleutels zijn WhatsApp peer-id's:

- groepschats: groeps-JID (bijv. `120363403215116621@g.us`)
- DM's: E.164-telefoonnummer (bijv. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Resultaat:** Wanneer OpenClaw in deze chat zou antwoorden, worden alle drie de agents uitgevoerd.

### Verwerkingsstrategie

Bepaal hoe agents berichten verwerken:

#### Parallel (standaard)

Alle agents verwerken gelijktijdig:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Sequentiële

Agents verwerken op volgorde (de volgende wacht tot de vorige klaar is):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Volledig voorbeeld

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

## Hoe het werkt

### Flow bericht

1. **Binnenkomend bericht** komt aan in een WhatsApp-groep
2. **Broadcastcontrole**: het systeem controleert of de peer-id in `broadcast` staat
3. **Indien in de broadcastlijst**:
   - Alle vermelde agents verwerken het bericht
   - Elke agent heeft zijn eigen sessiesleutel en geïsoleerde context
   - Agents verwerken parallel (standaard) of sequentieel
4. **Indien niet in de broadcastlijst**:
   - Normale routering is van toepassing (eerste overeenkomende binding)

Let op: broadcastgroepen omzeilen geen kanaal-allowlists of regels voor groepsactivatie (vermeldingen/opdrachten/etc.). Ze veranderen alleen _welke agents draaien_ wanneer een bericht in aanmerking komt voor verwerking.

### Sessiescheiding

Elke agent in een broadcastgroep behoudt volledig gescheiden:

- **Sessiesleutels** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Gespreksgeschiedenis** (agent ziet geen berichten van andere agents)
- **Werkruimte** (aparte sandboxes indien geconfigureerd)
- **Tooltoegang** (verschillende allow/deny-lijsten)
- **Geheugen/context** (aparte IDENTITY.md, SOUL.md, enz.)
- **Groepscontextbuffer** (recente groepsberichten die voor context worden gebruikt) wordt gedeeld per peer, zodat alle broadcast-agents bij activering dezelfde context zien

Dit maakt het mogelijk dat elke agent heeft:

- Verschillende persoonlijkheden
- Verschillende tooltoegang (bijv. alleen-lezen vs. lezen-schrijven)
- Verschillende modellen (bijv. opus vs. sonnet)
- Verschillende geïnstalleerde Skills

### Voorbeeld: geïsoleerde sessies

In groep `120363403215116621@g.us` met agents `["alfred", "baerbel"]`:

**Context van Alfred:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Context van Bärbel:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## Best practices

### 1. Houd agents gefocust

Ontwerp elke agent met één duidelijke verantwoordelijkheid:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Goed:** Elke agent heeft één taak  
❌ **Slecht:** Eén generieke "dev-helper"-agent

### 2. Gebruik beschrijvende namen

Maak duidelijk wat elke agent doet:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. Configureer verschillende tooltoegang

Geef agents alleen de tools die ze nodig hebben:

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

### 4. Monitor prestaties

Met veel agents, overweeg:

- Gebruik van `"strategy": "parallel"` (standaard) voor snelheid
- Beperk broadcastgroepen tot 5–10 agents
- Gebruik snellere modellen voor eenvoudigere agents

### 5. Ga netjes om met fouten

Agents falen onafhankelijk. Een fout bij één agent blokkeert de anderen niet:

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## Compatibiliteit

### Providers

Broadcastgroepen werken momenteel met:

- ✅ WhatsApp (geïmplementeerd)
- 🚧 Telegram (gepland)
- 🚧 Discord (gepland)
- 🚧 Slack (gepland)

### Routering

Broadcastgroepen werken naast bestaande routering:

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

- `GROUP_A`: Alleen alfred antwoordt (normale routering)
- `GROUP_B`: agent1 EN agent2 antwoorden (broadcast)

**Prioriteit:** `broadcast` heeft voorrang op `bindings`.

## Problemen oplossen

### Agents reageren niet

**Controleer:**

1. Agent-id's bestaan in `agents.list`
2. Peer-id-indeling is correct (bijv. `120363403215116621@g.us`)
3. Agents staan niet in deny-lijsten

**Debug:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### Slechts één agent reageert

**Oorzaak:** Peer-id staat mogelijk in `bindings` maar niet in `broadcast`.

**Oplossing:** Voeg toe aan de broadcastconfiguratie of verwijder uit bindings.

### Prestatieproblemen

**Als het traag is met veel agents:**

- Verminder het aantal agents per groep
- Gebruik lichtere modellen (sonnet in plaats van opus)
- Controleer de sandbox-opstarttijd

## Voorbeelden

### Voorbeeld 1: Code review-team

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

**Gebruiker stuurt:** Codefragment  
**Antwoorden:**

- code-formatter: "Inspringing hersteld en type hints toegevoegd"
- security-scanner: "⚠️ SQL-injectie-kwetsbaarheid in regel 12"
- test-coverage: "Dekking is 45%, ontbrekende tests voor foutgevallen"
- docs-checker: "Ontbrekende docstring voor functie `process_data`"

### Voorbeeld 2: Meertalige ondersteuning

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

## API-referentie

### Configuratieschema

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Velden

- `strategy` (optioneel): Hoe agents worden verwerkt
  - `"parallel"` (standaard): Alle agents verwerken gelijktijdig
  - `"sequential"`: Agents verwerken in arrayvolgorde
- `[peerId]`: WhatsApp-groeps-JID, E.164-nummer of andere peer-id
  - Waarde: Array met agent-id's die berichten moeten verwerken

## Beperkingen

1. **Max. agents:** Geen harde limiet, maar 10+ agents kunnen traag zijn
2. **Gedeelde context:** Agents zien elkaars antwoorden niet (bewust ontwerp)
3. **Berichtvolgorde:** Parallelle antwoorden kunnen in willekeurige volgorde aankomen
4. **Rate limits:** Alle agents tellen mee voor WhatsApp-rate limits

## Toekomstige uitbreidingen

Geplande functies:

- [ ] Gedeelde contextmodus (agents zien elkaars antwoorden)
- [ ] Agentcoördinatie (agents kunnen elkaar signaleren)
- [ ] Dynamische agentselectie (agents kiezen op basis van berichtinhoud)
- [ ] Agentprioriteiten (sommige agents antwoorden eerder dan andere)

## Zie ook

- [Multi-agentconfiguratie](/tools/multi-agent-sandbox-tools)
- [Routeringsconfiguratie](/channels/channel-routing)
- [Sessiebeheer](/concepts/sessions)
