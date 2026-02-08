---
summary: "Udsend en WhatsApp-besked til flere agenter"
read_when:
  - Konfiguration af broadcast-grupper
  - Fejlfinding af svar fra flere agenter i WhatsApp
status: experimental
title: "Broadcast-grupper"
x-i18n:
  source_path: channels/broadcast-groups.md
  source_hash: 25866bc0d519552d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:03Z
---

# Broadcast-grupper

**Status:** Eksperimentel  
**Version:** Tilføjet i 2026.1.9

## Overblik

Broadcast-grupper gør det muligt for flere agenter at behandle og svare på den samme besked samtidig. Det giver dig mulighed for at oprette specialiserede agentteams, der arbejder sammen i en enkelt WhatsApp-gruppe eller DM — alt sammen med ét telefonnummer.

Nuværende omfang: **Kun WhatsApp** (webkanal).

Broadcast-grupper evalueres efter kanalens tilladelseslister og regler for gruppeaktivering. I WhatsApp-grupper betyder det, at udsendelser sker, når OpenClaw normalt ville svare (for eksempel ved omtale, afhængigt af dine gruppeindstillinger).

## Anvendelsestilfælde

### 1. Specialiserede agentteams

Udrul flere agenter med atomare, fokuserede ansvarsområder:

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

Hver agent behandler den samme besked og bidrager med sit specialiserede perspektiv.

### 2. Understøttelse af flere sprog

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. Arbejdsgange til kvalitetssikring

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. Opgaveautomatisering

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Konfiguration

### Grundlæggende opsætning

Tilføj en topniveau-`broadcast`-sektion (ved siden af `bindings`). Nøglerne er WhatsApp peer-id’er:

- gruppechats: gruppe-JID (f.eks. `120363403215116621@g.us`)
- DM’er: E.164-telefonnummer (f.eks. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Resultat:** Når OpenClaw ville svare i denne chat, vil den køre alle tre agenter.

### Behandlingsstrategi

Styr, hvordan agenter behandler beskeder:

#### Parallel (standard)

Alle agenter behandler samtidig:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Sekventiel

Agenter behandles i rækkefølge (én venter på, at den forrige er færdig):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Fuldt eksempel

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

## Sådan virker det

### Beskedflow

1. **Indgående besked** ankommer i en WhatsApp-gruppe
2. **Broadcast-tjek**: Systemet kontrollerer, om peer-id’et er i `broadcast`
3. **Hvis i broadcast-listen**:
   - Alle angivne agenter behandler beskeden
   - Hver agent har sin egen sessionsnøgle og isolerede kontekst
   - Agenter behandler parallelt (standard) eller sekventielt
4. **Hvis ikke i broadcast-listen**:
   - Normal routing anvendes (første matchende binding)

Bemærk: Broadcast-grupper omgår ikke kanalens tilladelseslister eller regler for gruppeaktivering (omtaler/kommandoer/osv.). De ændrer kun _hvilke agenter der køres_, når en besked er berettiget til behandling.

### Sessionsisolering

Hver agent i en broadcast-gruppe opretholder fuldstændigt adskilte:

- **Sessionsnøgler** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Samtalehistorik** (agenten ser ikke andre agenters beskeder)
- **Arbejdsområde** (separate sandboxes, hvis konfigureret)
- **Værktøjsadgang** (forskellige tillad/afvis-lister)
- **Hukommelse/kontekst** (separate IDENTITY.md, SOUL.md osv.)
- **Gruppekontekstbuffer** (seneste gruppebeskeder brugt til kontekst) deles pr. peer, så alle broadcast-agenter ser den samme kontekst, når de udløses

Det giver hver agent mulighed for at have:

- Forskellige personligheder
- Forskellig værktøjsadgang (f.eks. skrivebeskyttet vs. læse-skrive)
- Forskellige modeller (f.eks. opus vs. sonnet)
- Forskellige Skills installeret

### Eksempel: Isolerede sessioner

I gruppen `120363403215116621@g.us` med agenterne `["alfred", "baerbel"]`:

**Alfreds kontekst:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Bärbels kontekst:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## Bedste praksis

### 1. Hold agenter fokuserede

Design hver agent med ét enkelt, klart ansvar:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Godt:** Hver agent har én opgave  
❌ **Dårligt:** Én generisk "dev-helper"-agent

### 2. Brug beskrivende navne

Gør det tydeligt, hvad hver agent laver:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. Konfigurer forskellig værktøjsadgang

Giv agenterne kun de værktøjer, de har brug for:

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

### 4. Overvåg ydeevne

Med mange agenter bør du overveje:

- At bruge `"strategy": "parallel"` (standard) for hastighed
- At begrænse broadcast-grupper til 5–10 agenter
- At bruge hurtigere modeller til simplere agenter

### 5. Håndtér fejl elegant

Agenter fejler uafhængigt. Én agents fejl blokerer ikke andre:

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## Kompatibilitet

### Udbydere

Broadcast-grupper fungerer i øjeblikket med:

- ✅ WhatsApp (implementeret)
- 🚧 Telegram (planlagt)
- 🚧 Discord (planlagt)
- 🚧 Slack (planlagt)

### Routing

Broadcast-grupper fungerer sammen med eksisterende routing:

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

- `GROUP_A`: Kun alfred svarer (normal routing)
- `GROUP_B`: agent1 OG agent2 svarer (broadcast)

**Prioritet:** `broadcast` har forrang over `bindings`.

## Fejlfinding

### Agenter svarer ikke

**Tjek:**

1. Agent-id’er findes i `agents.list`
2. Peer-id-formatet er korrekt (f.eks. `120363403215116621@g.us`)
3. Agenter er ikke i afvisningslister

**Debug:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### Kun én agent svarer

**Årsag:** Peer-id’et kan være i `bindings` men ikke i `broadcast`.

**Løsning:** Tilføj til broadcast-konfigurationen eller fjern fra bindings.

### Ydeevneproblemer

**Hvis det er langsomt med mange agenter:**

- Reducér antallet af agenter pr. gruppe
- Brug lettere modeller (sonnet i stedet for opus)
- Tjek sandbox-opstartstid

## Eksempler

### Eksempel 1: Kodegennemgangsteam

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

**Bruger sender:** Kodestump  
**Svar:**

- code-formatter: "Rettede indrykning og tilføjede type hints"
- security-scanner: "⚠️ SQL-injektionssårbarhed på linje 12"
- test-coverage: "Dækningen er 45 %, mangler tests for fejlsituationer"
- docs-checker: "Manglende docstring for funktionen `process_data`"

### Eksempel 2: Understøttelse af flere sprog

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

## API-reference

### Konfigurationsskema

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Felter

- `strategy` (valgfri): Hvordan agenter behandles
  - `"parallel"` (standard): Alle agenter behandler samtidigt
  - `"sequential"`: Agenter behandles i array-rækkefølge
- `[peerId]`: WhatsApp gruppe-JID, E.164-nummer eller andet peer-id
  - Værdi: Array af agent-id’er, der skal behandle beskeder

## Begrænsninger

1. **Maks. agenter:** Ingen hård grænse, men 10+ agenter kan være langsomt
2. **Delt kontekst:** Agenter ser ikke hinandens svar (bevidst design)
3. **Beskedrækkefølge:** Parallelle svar kan ankomme i vilkårlig rækkefølge
4. **Rate limits:** Alle agenter tæller med i WhatsApps rate limits

## Fremtidige forbedringer

Planlagte funktioner:

- [ ] Delt kontekst-tilstand (agenter ser hinandens svar)
- [ ] Agentkoordinering (agenter kan signalere til hinanden)
- [ ] Dynamisk agentvalg (vælg agenter baseret på beskedindhold)
- [ ] Agentprioriteter (nogle agenter svarer før andre)

## Se også

- [Multi-Agent Configuration](/tools/multi-agent-sandbox-tools)
- [Routing Configuration](/channels/channel-routing)
- [Session Management](/concepts/sessions)
