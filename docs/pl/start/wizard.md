---
summary: "Kreator wdrażania CLI: prowadzona konfiguracja gateway, obszaru roboczego, kanałów i Skills"
read_when:
  - Uruchamianie lub konfigurowanie kreatora wdrażania
  - Konfiguracja nowej maszyny
title: "Kreator wdrażania (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Kreator wdrażania (CLI)

Kreator wdrażania to **zalecany** sposób konfiguracji OpenClaw na macOS,
Linux lub Windows (przez WSL2; zdecydowanie zalecane).
Konfiguruje lokalny Gateway lub zdalne połączenie z Gateway, a także kanały, Skills
oraz ustawienia domyślne obszaru roboczego w jednym, prowadzonym procesie.

```bash
openclaw onboard
```

<Info>
Najszybsza pierwsza rozmowa: otwórz interfejs Control UI (bez potrzeby konfiguracji kanałów). Uruchom
`openclaw dashboard` i rozmawiaj w przeglądarce. Dokumentacja: [Dashboard](/web/dashboard).
</Info>

Aby ponownie skonfigurować później:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` nie oznacza trybu nieinteraktywnego. Do skryptów użyj `--non-interactive`.
</Note>

<Tip>
Zalecane: skonfiguruj klucz API Brave Search, aby agent mógł używać `web_search`
(`web_fetch` działa bez klucza). Najprostsza ścieżka: `openclaw configure --section web`,
które zapisuje `tools.web.search.apiKey`. Dokumentacja: [Web tools](/tools/web).
</Tip>

## Szybki start vs Zaawansowane

Kreator rozpoczyna się od wyboru **Szybki start** (ustawienia domyślne) lub **Zaawansowane** (pełna kontrola).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Lokalny gateway (local loopback)
    - Domyślny obszar roboczy (lub istniejący obszar roboczy)
    - Port Gateway **18789**
    - Uwierzytelnianie Gateway **Token** (automatycznie generowane, nawet na loopback)
    - Ekspozycja Tailscale **Wyłączone**
    - DM-y Telegram i WhatsApp domyślnie ustawione na **lista dozwolonych** (zostaniesz poproszony o numer telefonu)
  </Tab>
  <Tab title="Advanced (full control)">
    - Ujawnia każdy krok (tryb, obszar roboczy, gateway, kanały, demon, Skills).
  </Tab>
</Tabs>

## Co konfiguruje kreator

**Tryb lokalny (domyślny)** prowadzi przez następujące kroki:

1. **Model/Uwierzytelnianie** — klucz API Anthropic (zalecane), OAuth, OpenAI lub inni dostawcy. Wybór domyślnego modelu.
2. **Obszar roboczy** — lokalizacja plików agenta (domyślnie `~/.openclaw/workspace`). Zasiewa pliki startowe.
3. **Gateway** — port, adres nasłuchiwania, tryb uwierzytelniania, ekspozycja Tailscale.
4. **Kanały** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles lub iMessage.
5. **Demon** — instaluje LaunchAgent (macOS) lub jednostkę użytkownika systemd (Linux/WSL2).
6. **Sprawdzenie stanu** — uruchamia Gateway i weryfikuje, że działa.
7. **Skills** — instaluje zalecane Skills oraz opcjonalne zależności.

<Note>
Ponowne uruchomienie kreatora **nie** usuwa niczego, chyba że jawnie wybierzesz **Reset** (lub przekażesz `--reset`).
Jeśli konfiguracja jest nieprawidłowa lub zawiera przestarzałe klucze, kreator poprosi o wcześniejsze uruchomienie `openclaw doctor`.
</Note>

**Tryb zdalny** konfiguruje wyłącznie lokalnego klienta do połączenia z Gateway znajdującym się gdzie indziej.
**Nie** instaluje ani nie zmienia niczego na hoście zdalnym.

## Dodaj kolejnego agenta

Użyj `openclaw agents add <name>`, aby utworzyć oddzielnego agenta z własnym obszarem roboczym,
sesjami i profilami uwierzytelniania. Uruchomienie bez `--workspace` uruchamia kreator.

Co jest ustawiane:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Uwagi:

- Domyślne obszary robocze są zgodne z `~/.openclaw/workspace-<agentId>`.
- Dodaj `bindings`, aby kierować wiadomości przychodzące (kreator może to zrobić).
- Flagi nieinteraktywne: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Pełne odniesienie

Aby uzyskać szczegółowe opisy krok po kroku, skrypty nieinteraktywne, konfigurację Signal,
API RPC oraz pełną listę pól konfiguracji zapisywanych przez kreator, zobacz
[Wizard Reference](/reference/wizard).

## Powiązana dokumentacja

- Referencja poleceń CLI: [`openclaw onboard`](/cli/onboard)
- Wdrażanie aplikacji na macOS: [Onboarding](/start/onboarding)
- Rytuał pierwszego uruchomienia agenta: [Agent Bootstrapping](/start/bootstrapping)
