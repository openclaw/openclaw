---
summary: "Kompleksowy przewodnik uruchamiania OpenClaw jako osobistego asystenta z zachowaniem zasad bezpieczeństwa"
read_when:
  - Wdrażanie nowej instancji asystenta
  - Przegląd implikacji bezpieczeństwa i uprawnień
title: "Konfiguracja osobistego asystenta"
---

# Budowanie osobistego asystenta z OpenClaw

OpenClaw to gateway WhatsApp + Telegram + Discord + iMessage dla agentów **Pi**. Wtyczki dodają Mattermost. Ten przewodnik opisuje konfigurację „osobistego asystenta”: jeden dedykowany numer WhatsApp, który zachowuje się jak zawsze włączony agent.

## ⚠️ Bezpieczeństwo przede wszystkim

Umieszczasz agenta w pozycji, która pozwala mu:

- uruchamiać polecenia na Twoim komputerze (w zależności od konfiguracji narzędzi Pi)
- czytać/zapisywać pliki w Twoim obszarze roboczym
- wysyłać wiadomości na zewnątrz przez WhatsApp/Telegram/Discord/Mattermost (wtyczka)

Zacznij zachowawczo:

- Zawsze ustaw `channels.whatsapp.allowFrom` (nigdy nie uruchamiaj otwartego na świat na swoim osobistym Macu).
- Używaj dedykowanego numeru WhatsApp dla asystenta.
- Heartbeats domyślnie działają teraz co 30 minut. Wyłącz je, dopóki nie zaufasz konfiguracji, ustawiając `agents.defaults.heartbeat.every: "0m"`.

## Wymagania wstępne

- OpenClaw zainstalowany i wdrożony — zobacz [Pierwsze kroki](/start/getting-started), jeśli jeszcze tego nie zrobiłeś
- Drugi numer telefonu (SIM/eSIM/prepaid) dla asystenta

## Konfiguracja z dwoma telefonami (zalecane)

Chcesz tego:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Jeśli połączysz swój osobisty WhatsApp z OpenClaw, każda wiadomość do Ciebie stanie się „wejściem agenta”. Zwykle nie o to chodzi.

## Szybki start w 5 minut

1. Sparuj WhatsApp Web (wyświetla QR; zeskanuj telefonem asystenta):

```bash
openclaw channels login
```

2. Uruchom Gateway (pozostaw uruchomiony):

```bash
openclaw gateway --port 18789
```

3. Umieść minimalną konfigurację w `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Teraz wyślij wiadomość na numer asystenta ze swojego telefonu z listy dozwolonych.

Po zakończeniu wdrażania automatycznie otwieramy panel i drukujemy czysty (bez tokenów) link. Jeśli pojawi się prośba o uwierzytelnienie, wklej token z `gateway.auth.token` w ustawieniach Control UI. Aby otworzyć ponownie później: `openclaw dashboard`.

## Nadaj agentowi obszar roboczy (AGENTS)

OpenClaw odczytuje instrukcje operacyjne i „pamięć” z katalogu obszaru roboczego.

Domyślnie OpenClaw używa `~/.openclaw/workspace` jako obszaru roboczego agenta i utworzy go (wraz ze startowymi `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automatycznie podczas konfiguracji/pierwszego uruchomienia agenta. `BOOTSTRAP.md` jest tworzony tylko wtedy, gdy obszar roboczy jest zupełnie nowy (nie powinien wracać po jego usunięciu). `MEMORY.md` jest opcjonalny (nie jest tworzony automatycznie); jeśli istnieje, jest ładowany dla normalnych sesji. Sesje subagentów wstrzykują tylko `AGENTS.md` i `TOOLS.md`.

Wskazówka: traktuj ten folder jak „pamięć” OpenClaw i zrób z niego repozytorium git (najlepiej prywatne), aby Twoje `AGENTS.md` + pliki pamięci były objęte kopią zapasową. Jeśli git jest zainstalowany, zupełnie nowe obszary robocze są inicjalizowane automatycznie.

```bash
openclaw setup
```

Pełny układ obszaru roboczego + przewodnik tworzenia kopii zapasowych: [Agent workspace](/concepts/agent-workspace)
Przepływ pracy z pamięcią: [Memory](/concepts/memory)

Opcjonalnie: wybierz inny obszar roboczy za pomocą `agents.defaults.workspace` (obsługuje `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Jeśli już dostarczasz własne pliki obszaru roboczego z repozytorium, możesz całkowicie wyłączyć tworzenie plików bootstrap:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Konfiguracja, która zmienia to w „asystenta”

OpenClaw domyślnie oferuje dobrą konfigurację asystenta, ale zwykle warto dostroić:

- personę/instrukcje w `SOUL.md`
- domyślne ustawienia „thinking” (jeśli pożądane)
- heartbeats (gdy już mu zaufasz)

Przykład:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Sesje i pamięć

- Pliki sesji: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Metadane sesji (zużycie tokenów, ostatnia trasa itp.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` lub `/reset` rozpoczyna świeżą sesję dla tego czatu (konfigurowalne przez `resetTriggers`). Wysłane samodzielnie powoduje, że agent odpowiada krótkim powitaniem w celu potwierdzenia resetu.
- `/compact [instructions]` kompresuje kontekst sesji i raportuje pozostały budżet kontekstu.

## Heartbeats (tryb proaktywny)

Domyślnie OpenClaw uruchamia heartbeat co 30 minut z promptem:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Ustaw `agents.defaults.heartbeat.every: "0m"`, aby wyłączyć.

- Jeśli `HEARTBEAT.md` istnieje, ale jest faktycznie pusty (tylko puste linie i nagłówki Markdown, takie jak `# Heading`), OpenClaw pomija uruchomienie heartbeat, aby oszczędzać wywołania API.
- Jeśli plik nie istnieje, heartbeat nadal się uruchamia, a model decyduje, co zrobić.
- Jeśli agent odpowie `HEARTBEAT_OK` (opcjonalnie z krótkim wypełnieniem; zobacz `agents.defaults.heartbeat.ackMaxChars`), OpenClaw tłumi wysyłkę wychodzącą dla tego heartbeat.
- Heartbeats wykonują pełne tury agenta — krótsze interwały spalają więcej tokenów.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Media przychodzące i wychodzące

Załączniki przychodzące (obrazy/audio/dokumenty) mogą być udostępnione Twojemu poleceniu poprzez szablony:

- `{{MediaPath}}` (lokalna ścieżka pliku tymczasowego)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (jeśli włączona jest transkrypcja audio)

Załączniki wychodzące od agenta: umieść `MEDIA:<path-or-url>` w osobnej linii (bez spacji). Przykład:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw wyodrębnia je i wysyła jako media wraz z tekstem.

## Lista kontrolna operacji

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Logi znajdują się w `/tmp/openclaw/` (domyślnie: `openclaw-YYYY-MM-DD.log`).

## Następne kroki

- WebChat: [WebChat](/web/webchat)
- Operacje Gateway: [Gateway runbook](/gateway)
- Cron + wybudzania: [Cron jobs](/automation/cron-jobs)
- Towarzysząca aplikacja paska menu macOS: [OpenClaw macOS app](/platforms/macos)
- Aplikacja węzła iOS: [iOS app](/platforms/ios)
- Aplikacja węzła Android: [Android app](/platforms/android)
- Status Windows: [Windows (WSL2)](/platforms/windows)
- Status Linux: [Linux app](/platforms/linux)
- Bezpieczeństwo: [Security](/gateway/security)
