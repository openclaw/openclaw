---
summary: "„Kompletne kompendium przepływu onboardingu CLI, konfiguracji uwierzytelniania/modeli, wyjść i elementów wewnętrznych”"
read_when:
  - „Potrzebujesz szczegółowego opisu zachowania onboardingu OpenClaw”
  - „Debugujesz wyniki onboardingu lub integrujesz klientów onboardingu”
title: "„Referencja onboardingu CLI”"
sidebarTitle: "CLI reference"
---

# Referencja onboardingu CLI

Ta strona stanowi pełną referencję dla `openclaw onboard`.
Krótki przewodnik znajdziesz w [Onboarding Wizard (CLI)](/start/wizard).

## Co robi kreator

Tryb lokalny (domyślny) prowadzi przez:

- Konfigurację modelu i uwierzytelniania (OAuth subskrypcji OpenAI Code, klucz API Anthropic lub setup-token, a także opcje MiniMax, GLM, Moonshot i AI Gateway)
- Lokalizację obszaru roboczego i pliki bootstrap
- Ustawienia Gateway (port, bind, auth, Tailscale)
- Kanały i dostawców (Telegram, WhatsApp, Discord, Google Chat, wtyczka Mattermost, Signal)
- Instalację demona (LaunchAgent lub jednostka użytkownika systemd)
- Kontrola zdrowia
- Konfigurację Skills

Tryb zdalny konfiguruje tę maszynę do łączenia się z gatewayem w innym miejscu.
Nie instaluje ani nie modyfikuje niczego na hoście zdalnym.

## Szczegóły przepływu lokalnego

<Steps>
  <Step title="Existing config detection">
    - Jeśli istnieje `~/.openclaw/openclaw.json`, wybierz Zachowaj, Zmodyfikuj lub Resetuj.
    - Ponowne uruchomienie kreatora nie usuwa niczego, chyba że jawnie wybierzesz Reset (lub przekażesz `--reset`).
    - Jeśli konfiguracja jest nieprawidłowa lub zawiera klucze legacy, kreator zatrzymuje się i prosi o uruchomienie `openclaw doctor` przed kontynuacją.
    - Reset używa `trash` i oferuje zakresy:
      - Tylko konfiguracja
      - Konfiguracja + poświadczenia + sesje
      - Pełny reset (usuwa także obszar roboczy)  
</Step>
  <Step title="Model and auth">
    - Pełna macierz opcji znajduje się w [Auth and model options](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Domyślnie `~/.openclaw/workspace` (konfigurowalne).
    - Zasiewa pliki obszaru roboczego potrzebne do rytuału bootstrap przy pierwszym uruchomieniu.
    - Układ obszaru roboczego: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Pyta o port, bind, tryb auth oraz ekspozycję Tailscale.
    - Zalecane: pozostaw włączone uwierzytelnianie tokenem nawet dla loopback, aby lokalni klienci WS musieli się uwierzytelnić.
    - Wyłącz uwierzytelnianie tylko wtedy, gdy w pełni ufasz każdemu lokalnemu procesowi.
    - Bindowania inne niż loopback nadal wymagają uwierzytelniania.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): opcjonalne logowanie QR
    - [Telegram](/channels/telegram): token bota
    - [Discord](/channels/discord): token bota
    - [Google Chat](/channels/googlechat): JSON konta usługi + odbiorca webhooka
    - Wtyczka [Mattermost](/channels/mattermost): token bota + bazowy URL
    - [Signal](/channels/signal): opcjonalna instalacja `signal-cli` + konfiguracja konta
    - [BlueBubbles](/channels/bluebubbles): zalecane dla iMessage; URL serwera + hasło + webhook
    - [iMessage](/channels/imessage): legacy ścieżka CLI `imsg` + dostęp do DB
    - Bezpieczeństwo DM-ów: domyślnie parowanie. Pierwszy DM wysyła kod; zatwierdź przez
      `openclaw pairing approve <channel><code>` lub użyj list dozwolonych.
  </Step><code>` lub użyj list dozwolonych.
  </Step>
  <Step title="Instalacja demona">
    - macOS: LaunchAgent
      - Wymaga zalogowanej sesji użytkownika; dla trybu headless użyj niestandardowego LaunchDaemon (nie jest dostarczany).
    - Linux i Windows przez WSL2: jednostka użytkownika systemd
      - Kreator próbuje `loginctl enable-linger <user>`, aby gateway działał po wylogowaniu.
      - Może poprosić o sudo (zapisuje `/var/lib/systemd/linger`); najpierw próbuje bez sudo.
    - Wybór środowiska uruchomieniowego: Node (zalecane; wymagane dla WhatsApp i Telegram). Bun nie jest zalecany.
  </Step>
  <Step title="Kontrola stanu">
    - Uruchamia gateway (jeśli potrzebne) i wykonuje `openclaw health`.
    - `openclaw status --deep` dodaje sondy zdrowia gatewaya do wyjścia statusu.
  </Step>
  <Step title="Skills">
    - Odczytuje dostępne Skills i sprawdza wymagania.
    - Pozwala wybrać menedżera pakietów Node: npm lub pnpm (bun nie jest zalecany).
    - Instaluje opcjonalne zależności (niektóre używają Homebrew na macOS).
  </Step>
  <Step title="Zakończenie">
    - Podsumowanie i następne kroki, w tym opcje aplikacji na iOS, Android i macOS.
  </Step>
</Steps>

<Note>
Jeśli nie wykryto GUI, kreator wypisuje instrukcje przekierowania portów SSH dla Control UI zamiast otwierać przeglądarkę.
Jeśli zasoby Control UI są niedostępne, kreator próbuje je zbudować; rozwiązaniem awaryjnym jest `pnpm ui:build` (automatyczna instalacja zależności UI).
</Note>

## Szczegóły trybu zdalnego

Tryb zdalny konfiguruje tę maszynę do łączenia się z gatewayem w innym miejscu.

<Info>
Tryb zdalny nie instaluje ani nie modyfikuje niczego na hoście zdalnym.
</Info>

Co ustawiasz:

- Zdalny URL gatewaya (`ws://...`)
- Token, jeśli zdalny gateway wymaga uwierzytelniania (zalecane)

<Note>
- Jeśli gateway jest dostępny tylko przez loopback, użyj tunelowania SSH lub tailnetu.
- Wskazówki wykrywania:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Opcje uwierzytelniania i modeli

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Używa `ANTHROPIC_API_KEY`, jeśli jest obecny, lub prosi o klucz, a następnie zapisuje go do użycia przez demona.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: sprawdza element pęku kluczy „Claude Code-credentials”
    - Linux i Windows: ponownie wykorzystuje `~/.claude/.credentials.json`, jeśli jest obecny

    ```
    Na macOS wybierz „Always Allow”, aby uruchomienia launchd nie były blokowane.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Uruchom `claude setup-token` na dowolnej maszynie, a następnie wklej token.
    Możesz nadać mu nazwę; puste pole użyje domyślnej.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Jeśli istnieje `~/.codex/auth.json`, kreator może go ponownie wykorzystać.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Przepływ w przeglądarce; wklej `code#state`.

    ```
    Ustawia `agents.defaults.model` na `openai-codex/gpt-5.3-codex`, gdy model nie jest ustawiony lub jest `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Używa `OPENAI_API_KEY`, jeśli jest obecny, lub prosi o klucz, a następnie zapisuje go do
    `~/.openclaw/.env`, aby launchd mógł go odczytać.

    ```
    Ustawia `agents.defaults.model` na `openai/gpt-5.1-codex`, gdy model nie jest ustawiony, jest `openai/*` lub `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Prosi o `XAI_API_KEY` i konfiguruje xAI jako dostawcę modeli.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prosi o `OPENCODE_API_KEY` (lub `OPENCODE_ZEN_API_KEY`).
    URL konfiguracji: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Przechowuje klucz za Ciebie.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Prosi o `AI_GATEWAY_API_KEY`.
    Więcej szczegółów: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Prosi o identyfikator konta, identyfikator gatewaya oraz `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Więcej szczegółów: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Konfiguracja jest zapisywana automatycznie.
    Więcej szczegółów: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prosi o `SYNTHETIC_API_KEY`.
    Więcej szczegółów: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Konfiguracje Moonshot (Kimi K2) i Kimi Coding są zapisywane automatycznie.
    Więcej szczegółów: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Pozostawia uwierzytelnianie nieskonfigurowane.
  </Accordion>
</AccordionGroup>

Zachowanie modeli:

- Wybierz domyślny model z wykrytych opcji albo wprowadź dostawcę i model ręcznie.
- Kreator uruchamia kontrolę modelu i ostrzega, jeśli skonfigurowany model jest nieznany lub brakuje uwierzytelniania.

Ścieżki poświadczeń i profili:

- Poświadczenia OAuth: `~/.openclaw/credentials/oauth.json`
- Profile uwierzytelniania (klucze API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Wskazówka dla trybu headless i serwerów: ukończ OAuth na maszynie z przeglądarką, a następnie skopiuj
`~/.openclaw/credentials/oauth.json` (lub `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
na host Gateway.
</Note>

## Wyjścia i elementy wewnętrzne

Typowe pola w `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (jeśli wybrano Minimax)
- `gateway.*` (tryb, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listy dozwolonych kanałów (Slack, Discord, Matrix, Microsoft Teams), gdy wybierzesz je podczas promptów (nazwy są rozwiązywane do identyfikatorów, gdy to możliwe)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` zapisuje `agents.list[]` oraz opcjonalnie `bindings`.

Poświadczenia WhatsApp trafiają do `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sesje są przechowywane w `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Niektóre kanały są dostarczane jako wtyczki. Po wybraniu podczas onboardingu kreator
prosi o instalację wtyczki (npm lub ścieżka lokalna) przed konfiguracją kanału.
</Note>

RPC kreatora Gateway:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Klienci (aplikacja na macOS i Control UI) mogą renderować kroki bez ponownej implementacji logiki onboardingu.

Zachowanie konfiguracji Signal:

- Pobiera odpowiedni zasób wydania
- Przechowuje go w `~/.openclaw/tools/signal-cli/<version>/`
- Zapisuje `channels.signal.cliPath` w konfiguracji
- Kompilacje JVM wymagają Java 21
- Gdy dostępne, używane są kompilacje natywne
- Windows korzysta z WSL2 i realizuje przepływ signal-cli Linuksa wewnątrz WSL

## Powiązana dokumentacja

- Centrum onboardingu: [Onboarding Wizard (CLI)](/start/wizard)
- Automatyzacja i skrypty: [CLI Automation](/start/wizard-cli-automation)
- Referencja poleceń: [`openclaw onboard`](/cli/onboard)
