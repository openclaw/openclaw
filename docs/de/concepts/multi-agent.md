---
summary: "Multi-Agent-Routing: isolierte Agenten, Kanal-Konten und Bindungen"
title: Multi-Agent-Routing
read_when: "Sie möchten mehrere isolierte Agenten (Workspaces + Auth) in einem Gateway-Prozess."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:04Z
---

# Multi-Agent-Routing

Ziel: mehrere _isolierte_ Agenten (separater Workspace + `agentDir` + Sitzungen) sowie mehrere Kanal-Konten (z. B. zwei WhatsApps) in einem laufenden Gateway. Eingehende Nachrichten werden über Bindungen einem Agenten zugeordnet.

## Was ist „ein Agent“?

Ein **Agent** ist ein vollständig abgegrenztes „Gehirn“ mit eigenem:

- **Workspace** (Dateien, AGENTS.md/SOUL.md/USER.md, lokale Notizen, Persona-Regeln).
- **State-Verzeichnis** (`agentDir`) für Auth-Profile, Modell-Registry und agentenspezifische Konfiguration.
- **Sitzungsspeicher** (Chatverlauf + Routing-Zustand) unter `~/.openclaw/agents/<agentId>/sessions`.

Auth-Profile sind **pro Agent**. Jeder Agent liest aus seinem eigenen:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Anmeldedaten des Hauptagenten werden **nicht** automatisch geteilt. Verwenden Sie `agentDir` niemals
über Agenten hinweg erneut (das verursacht Auth-/Sitzungskollisionen). Wenn Sie Anmeldedaten teilen möchten,
kopieren Sie `auth-profiles.json` in das `agentDir` des anderen Agenten.

Skills sind pro Agent über den `skills/`-Ordner jedes Workspaces verfügbar; gemeinsam genutzte Skills
stehen unter `~/.openclaw/skills` bereit. Siehe [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Das Gateway kann **einen Agenten** (Standard) oder **viele Agenten** nebeneinander hosten.

**Workspace-Hinweis:** Der Workspace jedes Agenten ist das **Standard-cwd**, keine harte
sandbox. Relative Pfade werden innerhalb des Workspaces aufgelöst, absolute Pfade können jedoch
andere Host-Speicherorte erreichen, sofern sandboxing nicht aktiviert ist. Siehe
[Sandboxing](/gateway/sandboxing).

## Pfade (Kurzüberblick)

- Konfiguration: `~/.openclaw/openclaw.json` (oder `OPENCLAW_CONFIG_PATH`)
- State-Verzeichnis: `~/.openclaw` (oder `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (oder `~/.openclaw/workspace-<agentId>`)
- Agentenverzeichnis: `~/.openclaw/agents/<agentId>/agent` (oder `agents.list[].agentDir`)
- Sitzungen: `~/.openclaw/agents/<agentId>/sessions`

### Einzelagentenmodus (Standard)

Wenn Sie nichts tun, läuft OpenClaw mit einem einzelnen Agenten:

- `agentId` ist standardmäßig **`main`**.
- Sitzungen werden als `agent:main:<mainKey>` geführt.
- Der Workspace ist standardmäßig `~/.openclaw/workspace` (oder `~/.openclaw/workspace-<profile>`, wenn `OPENCLAW_PROFILE` gesetzt ist).
- Der State ist standardmäßig `~/.openclaw/agents/main/agent`.

## Agenten-Helfer

Verwenden Sie den Agenten-Assistenten, um einen neuen isolierten Agenten hinzuzufügen:

```bash
openclaw agents add work
```

Fügen Sie anschließend `bindings` hinzu (oder lassen Sie das den Assistenten erledigen), um eingehende Nachrichten zu routen.

Überprüfen Sie mit:

```bash
openclaw agents list --bindings
```

## Mehrere Agenten = mehrere Personen, mehrere Persönlichkeiten

Mit **mehreren Agenten** wird jeder `agentId` zu einer **vollständig isolierten Persona**:

- **Unterschiedliche Telefonnummern/Konten** (pro Kanal `accountId`).
- **Unterschiedliche Persönlichkeiten** (agentenspezifische Workspace-Dateien wie `AGENTS.md` und `SOUL.md`).
- **Getrennte Auth + Sitzungen** (keine Überschneidungen, außer explizit aktiviert).

So können **mehrere Personen** einen Gateway-Server teilen, während ihre KI-„Gehirne“ und Daten isoliert bleiben.

## Eine WhatsApp-Nummer, mehrere Personen (DM-Aufteilung)

Sie können **verschiedene WhatsApp-Direktnachrichten** unterschiedlichen Agenten zuordnen und dabei **ein einziges WhatsApp-Konto** verwenden. Matchen Sie nach Absender-E.164 (wie `+15551234567`) mit `peer.kind: "dm"`. Antworten kommen weiterhin von derselben WhatsApp-Nummer (keine agentenspezifische Absenderidentität).

Wichtiges Detail: Direktchats fallen auf den **Haupt-Sitzungsschlüssel** des Agenten zurück, daher erfordert echte Isolation **einen Agenten pro Person**.

Beispiel:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Hinweise:

- DM-Zugriffskontrolle ist **global pro WhatsApp-Konto** (Pairing/Allowlist), nicht pro Agent.
- Für geteilte Gruppen binden Sie die Gruppe an einen Agenten oder verwenden Sie [Broadcast groups](/channels/broadcast-groups).

## Routing-Regeln (wie Nachrichten einen Agenten wählen)

Bindungen sind **deterministisch** und **die spezifischste gewinnt**:

1. `peer`-Match (exakte DM-/Gruppen-/Kanal-ID)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. `accountId`-Match für einen Kanal
5. Kanalweite Übereinstimmung (`accountId: "*"`)
6. Fallback auf Standardagent (`agents.list[].default`, andernfalls erster Listeneintrag, Standard: `main`)

## Mehrere Konten / Telefonnummern

Kanäle mit Unterstützung für **mehrere Konten** (z. B. WhatsApp) verwenden `accountId`, um
jede Anmeldung zu identifizieren. Jedes `accountId` kann einem anderen Agenten zugeordnet werden,
sodass ein Server mehrere Telefonnummern hosten kann, ohne Sitzungen zu vermischen.

## Konzepte

- `agentId`: ein „Gehirn“ (Workspace, agentenspezifische Auth, agentenspezifischer Sitzungsspeicher).
- `accountId`: eine Kanal-Konto-Instanz (z. B. WhatsApp-Konto `"personal"` vs. `"biz"`).
- `binding`: routet eingehende Nachrichten zu einem `agentId` anhand von `(channel, accountId, peer)` und optional Guild-/Team-IDs.
- Direktchats fallen auf `agent:<agentId>:<mainKey>` zurück (agentenspezifisches „main“; `session.mainKey`).

## Beispiel: zwei WhatsApps → zwei Agenten

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Beispiel: WhatsApp-Tageschat + Telegram-Tiefenarbeit

Aufteilung nach Kanal: Routen Sie WhatsApp zu einem schnellen Alltagsagenten und Telegram zu einem Opus-Agenten.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Hinweise:

- Wenn Sie mehrere Konten für einen Kanal haben, fügen Sie `accountId` zur Bindung hinzu (z. B. `{ channel: "whatsapp", accountId: "personal" }`).
- Um eine einzelne DM/Gruppe zu Opus zu routen und den Rest im Chat zu belassen, fügen Sie eine `match.peer`-Bindung für diesen Peer hinzu; Peer-Matches gewinnen immer gegenüber kanalweiten Regeln.

## Beispiel: gleicher Kanal, ein Peer zu Opus

Belassen Sie WhatsApp beim schnellen Agenten, routen Sie jedoch eine DM zu Opus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Peer-Bindungen gewinnen immer; platzieren Sie sie daher oberhalb der kanalweiten Regel.

## Familienagent an eine WhatsApp-Gruppe gebunden

Binden Sie einen dedizierten Familienagenten an eine einzelne WhatsApp-Gruppe, mit Mention-Gating
und einer restriktiveren Werkzeugrichtlinie:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Hinweise:

- Tool-Allow-/Deny-Listen beziehen sich auf **Werkzeuge**, nicht auf Skills. Wenn ein Skill ein
  Binary ausführen muss, stellen Sie sicher, dass `exec` erlaubt ist und das Binary in der sandbox vorhanden ist.
- Für strengere Einschränkungen setzen Sie `agents.list[].groupChat.mentionPatterns` und lassen Sie
  Gruppen-Allowlists für den Kanal aktiviert.

## Sandbox und Werkzeugkonfiguration pro Agent

Ab v2026.1.6 kann jeder Agent seine eigene sandbox und Werkzeugbeschränkungen haben:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

Hinweis: `setupCommand` befindet sich unter `sandbox.docker` und wird einmal bei der Container-Erstellung ausgeführt.
Agentenspezifische `sandbox.docker.*`-Überschreibungen werden ignoriert, wenn der aufgelöste Geltungsbereich `"shared"` ist.

**Vorteile:**

- **Sicherheitsisolation**: Werkzeuge für nicht vertrauenswürdige Agenten einschränken
- **Ressourcenkontrolle**: Bestimmte Agenten sandboxen, andere auf dem Host belassen
- **Flexible Richtlinien**: Unterschiedliche Berechtigungen pro Agent

Hinweis: `tools.elevated` ist **global** und absenderbasiert; es ist nicht pro Agent konfigurierbar.
Wenn Sie agentenspezifische Grenzen benötigen, verwenden Sie `agents.list[].tools`, um `exec` zu verweigern.
Für Gruppenzielsteuerung verwenden Sie `agents.list[].groupChat.mentionPatterns`, damit @Mentions sauber dem vorgesehenen Agenten zugeordnet werden.

Siehe [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) für detaillierte Beispiele.
