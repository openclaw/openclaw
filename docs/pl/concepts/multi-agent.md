---
summary: "„Routing wieloagentowy: izolowane agenty, konta kanałów i powiązania”"
title: Routing wieloagentowy
read_when: "„Gdy chcesz mieć wiele izolowanych agentów (obszary robocze + uwierzytelnianie) w jednym procesie Gateway.”"
status: active
---

# Routing wieloagentowy

Cel: wiele _izolowanych_ agentów (oddzielny obszar roboczy + `agentDir` + sesje), a także wiele kont kanałów (np. dwa WhatsAppy) w jednym uruchomionym Gateway. Ruch przychodzący jest kierowany do agenta za pomocą powiązań.

## Czym jest „jeden agent”?

**Agent** to w pełni wydzielony „mózg” z własnymi:

- **Obszarem roboczym** (pliki, AGENTS.md/SOUL.md/USER.md, notatki lokalne, reguły persony).
- **Katalogiem stanu** (`agentDir`) dla profili uwierzytelniania, rejestru modeli i konfiguracji per agent.
- **Magazynem sesji** (historia czatu + stan routingu) w `~/.openclaw/agents/<agentId>/sessions`.

Profile uwierzytelniania są **per agent**. Każdy agent odczytuje je z własnego:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Główne poświadczenia agenta **nie** są współdzielone automatycznie. Nigdy nie używaj ponownie `agentDir`
między agentami (powoduje to kolizje uwierzytelniania/sesji). Jeśli chcesz współdzielić poświadczenia,
skopiuj `auth-profiles.json` do `agentDir` innego agenta.

Skills są per agent poprzez folder `skills/` w każdym obszarze roboczym, a umiejętności współdzielone
są dostępne z `~/.openclaw/skills`. Zobacz [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Gateway może hostować **jednego agenta** (domyślnie) lub **wiele agentów** równolegle.

**Uwaga o obszarze roboczym:** obszar roboczy każdego agenta jest **domyślnym cwd**, a nie twardym
sandboxem. Ścieżki względne rozwiązują się wewnątrz obszaru roboczego, ale ścieżki bezwzględne mogą
sięgać innych lokalizacji hosta, o ile sandboxing nie jest włączony. Zobacz
[Sandboxing](/gateway/sandboxing).

## Ścieżki (szybka mapa)

- Konfiguracja: `~/.openclaw/openclaw.json` (lub `OPENCLAW_CONFIG_PATH`)
- Katalog stanu: `~/.openclaw` (lub `OPENCLAW_STATE_DIR`)
- Obszar roboczy: `~/.openclaw/workspace` (lub `~/.openclaw/workspace-<agentId>`)
- Katalog agenta: `~/.openclaw/agents/<agentId>/agent` (lub `agents.list[].agentDir`)
- Sesje: `~/.openclaw/agents/<agentId>/sessions`

### Tryb pojedynczego agenta (domyślny)

Jeśli nic nie zrobisz, OpenClaw uruchamia jednego agenta:

- `agentId` domyślnie wynosi **`main`**.
- Sesje są kluczowane jako `agent:main:<mainKey>`.
- Obszar roboczy domyślnie to `~/.openclaw/workspace` (lub `~/.openclaw/workspace-<profile>`, gdy ustawione jest `OPENCLAW_PROFILE`).
- Stan domyślnie to `~/.openclaw/agents/main/agent`.

## Pomocnik agenta

Użyj kreatora agenta, aby dodać nowego izolowanego agenta:

```bash
openclaw agents add work
```

Następnie dodaj `bindings` (lub pozwól, aby zrobił to kreator), aby routować wiadomości przychodzące.

Zweryfikuj za pomocą:

```bash
openclaw agents list --bindings
```

## Wiele agentów = wiele osób, wiele osobowości

Przy **wielu agentach** każdy `agentId` staje się **w pełni izolowaną personą**:

- **Różne numery telefonów/konta** (per kanał `accountId`).
- **Różne osobowości** (pliki obszaru roboczego per agent, takie jak `AGENTS.md` i `SOUL.md`).
- **Oddzielne uwierzytelnianie + sesje** (brak wzajemnych interakcji, o ile nie włączono ich jawnie).

Pozwala to **wielu osobom** współdzielić jeden serwer Gateway, zachowując izolację ich „mózgów” AI i danych.

## Jeden numer WhatsApp, wiele osób (podział DM)

Możesz kierować **różne DM-y WhatsApp** do różnych agentów, pozostając przy **jednym koncie WhatsApp**. Dopasuj po nadawcy E.164 (np. `+15551234567`) za pomocą `peer.kind: "dm"`. Odpowiedzi nadal wychodzą z tego samego numeru WhatsApp (brak tożsamości nadawcy per agent).

Ważny szczegół: czaty bezpośrednie zapadają się do **głównego klucza sesji** agenta, więc prawdziwa izolacja wymaga **jednego agenta na osobę**.

Przykład:

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

Uwagi:

- Kontrola dostępu do DM-ów jest **globalna per konto WhatsApp** (parowanie/lista dozwolonych), a nie per agent.
- Dla grup współdzielonych przypisz grupę do jednego agenta lub użyj [Broadcast groups](/channels/broadcast-groups).

## Reguły routingu (jak wiadomości wybierają agenta)

Powiązania są **deterministyczne** i obowiązuje zasada **najbardziej szczegółowe wygrywa**:

1. Dopasowanie `peer` (dokładny identyfikator DM/grupy/kanału)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. Dopasowanie `accountId` dla kanału
5. Dopasowanie na poziomie kanału (`accountId: "*"`)
6. Powrót do agenta domyślnego (`agents.list[].default`, w przeciwnym razie pierwszy wpis listy, domyślnie: `main`)

## Wiele kont / numerów telefonów

Kanały obsługujące **wiele kont** (np. WhatsApp) używają `accountId` do identyfikacji
każdego logowania. Każde `accountId` może być kierowane do innego agenta, dzięki czemu jeden serwer może hostować
wiele numerów telefonów bez mieszania sesji.

## Pojęcia

- `agentId`: jeden „mózg” (obszar roboczy, uwierzytelnianie per agent, magazyn sesji per agent).
- `accountId`: jedna instancja konta kanału (np. konto WhatsApp `"personal"` vs `"biz"`).
- `binding`: kieruje wiadomości przychodzące do `agentId` według `(channel, accountId, peer)` oraz opcjonalnie identyfikatorów gildii/zespołów.
- Czaty bezpośrednie zapadają się do `agent:<agentId>:<mainKey>` (per-agent „główna”; `session.mainKey`).

## Przykład: dwa WhatsAppy → dwóch agentów

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

## Przykład: WhatsApp do codziennych rozmów + Telegram do głębokiej pracy

Podział według kanału: kieruj WhatsApp do szybkiego agenta codziennego, a Telegram do agenta Opus.

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

Uwagi:

- Jeśli masz wiele kont dla danego kanału, dodaj `accountId` do powiązania (np. `{ channel: "whatsapp", accountId: "personal" }`).
- Aby skierować pojedynczy DM/grupę do Opus, pozostawiając resztę na czacie, dodaj powiązanie `match.peer` dla tego peera; dopasowania peera zawsze wygrywają nad regułami ogólnymi kanału.

## Przykład: ten sam kanał, jeden peer do Opus

Pozostaw WhatsApp na szybkim agencie, ale skieruj jeden DM do Opus:

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

Powiązania peer zawsze wygrywają, więc trzymaj je powyżej reguły obejmującej cały kanał.

## Agent rodzinny przypisany do grupy WhatsApp

Przypisz dedykowanego agenta rodzinnego do jednej grupy WhatsApp, z bramkowaniem przez wzmianki
i bardziej restrykcyjną polityką narzędzi:

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

Uwagi:

- Listy dozwolone/zabronione narzędzi dotyczą **narzędzi**, a nie skills. Jeśli skill musi uruchomić
  plik binarny, upewnij się, że `exec` jest dozwolone i że plik binarny istnieje w sandboxie.
- Dla bardziej restrykcyjnego bramkowania ustaw `agents.list[].groupChat.mentionPatterns` i pozostaw
  włączone listy dozwolonych grup dla kanału.

## Sandbox i konfiguracja narzędzi per agent

Od wersji v2026.1.6 każdy agent może mieć własny sandbox i ograniczenia narzędzi:

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

Uwaga: `setupCommand` znajduje się pod `sandbox.docker` i uruchamia się raz przy tworzeniu kontenera.
Nadpisania `sandbox.docker.*` per agent są ignorowane, gdy rozstrzygnięty zakres to `"shared"`.

**Korzyści:**

- **Izolacja bezpieczeństwa**: Ograniczanie narzędzi dla nieufnych agentów
- **Kontrola zasobów**: Sandboxowanie wybranych agentów przy pozostawieniu innych na hoście
- **Elastyczne polityki**: Różne uprawnienia per agent

Uwaga: `tools.elevated` jest **globalne** i oparte na nadawcy; nie jest konfigurowalne per agent.
Jeśli potrzebujesz granic per agent, użyj `agents.list[].tools`, aby zabronić `exec`.
Do targetowania grup użyj `agents.list[].groupChat.mentionPatterns`, aby wzmianki @ mapowały się jednoznacznie do zamierzonego agenta.

Zobacz [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools), aby zapoznać się ze szczegółowymi przykładami.
