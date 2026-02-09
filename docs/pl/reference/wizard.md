---
summary: "Pełna referencja kreatora onboardingu CLI: każdy krok, flaga i pole konfiguracji"
read_when:
  - Szukanie konkretnego kroku kreatora lub flagi
  - Automatyzowanie onboardingu w trybie nieinteraktywnym
  - Debugowanie zachowania kreatora
title: "Referencja kreatora onboardingu"
sidebarTitle: "Wizard Reference"
---

# Referencja kreatora onboardingu

To jest pełna referencja kreatora CLI `openclaw onboard`.
Aby uzyskać przegląd wysokiego poziomu, zobacz [Onboarding Wizard](/start/wizard).

## Szczegóły przepływu (tryb lokalny)

<Steps>
  <Step title="Existing config detection">
    - Jeśli istnieje `~/.openclaw/openclaw.json`, wybierz **Zachowaj / Zmień / Resetuj**.
    - Ponowne uruchomienie kreatora **nie** czyści niczego, chyba że jawnie wybierzesz **Resetuj**
      (lub przekażesz `--reset`).
    - Jeśli konfiguracja jest nieprawidłowa lub zawiera przestarzałe klucze, kreator zatrzyma się i poprosi
      o uruchomienie `openclaw doctor` przed kontynuacją.
    - Reset używa `trash` (nigdy `rm`) i oferuje zakresy:
      - Tylko konfiguracja
      - Konfiguracja + poświadczenia + sesje
      - Pełny reset (usuwa także obszar roboczy)  
</Step>
  <Step title="Model/Auth">
    - **Klucz API Anthropic (zalecane)**: używa `ANTHROPIC_API_KEY`, jeśli jest obecny, lub prosi o klucz, a następnie zapisuje go do użytku przez demona.
    - **Anthropic OAuth (Claude Code CLI)**: na macOS kreator sprawdza element pęku kluczy „Claude Code-credentials” (wybierz „Always Allow”, aby uruchomienia launchd nie były blokowane); na Linux/Windows ponownie używa `~/.claude/.credentials.json`, jeśli jest obecny.
    - **Token Anthropic (wklej setup-token)**: uruchom `claude setup-token` na dowolnej maszynie, a następnie wklej token (możesz go nazwać; puste = domyślny).
    - **Subskrypcja OpenAI Code (Codex) (Codex CLI)**: jeśli istnieje `~/.codex/auth.json`, kreator może go ponownie użyć.
    - **Subskrypcja OpenAI Code (Codex) (OAuth)**: przepływ w przeglądarce; wklej `code#state`.
      - Ustawia `agents.defaults.model` na `openai-codex/gpt-5.2`, gdy model nie jest ustawiony lub jest `openai/*`.
    - **Klucz API OpenAI**: używa `OPENAI_API_KEY`, jeśli jest obecny, lub prosi o klucz, a następnie zapisuje go do `~/.openclaw/.env`, aby launchd mógł go odczytać.
    - **Klucz API xAI (Grok)**: prosi o `XAI_API_KEY` i konfiguruje xAI jako dostawcę modeli.
    - **OpenCode Zen (wielomodelowy proxy)**: prosi o `OPENCODE_API_KEY` (lub `OPENCODE_ZEN_API_KEY`, uzyskaj na https://opencode.ai/auth).
    - **Klucz API**: zapisuje klucz za Ciebie.
    - **Vercel AI Gateway (wielomodelowy proxy)**: prosi o `AI_GATEWAY_API_KEY`.
    - Więcej szczegółów: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prosi o Account ID, Gateway ID oraz `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Więcej szczegółów: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: konfiguracja jest zapisywana automatycznie.
    - Więcej szczegółów: [MiniMax](/providers/minimax)
    - **Synthetic (zgodny z Anthropic)**: prosi o `SYNTHETIC_API_KEY`.
    - Więcej szczegółów: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: konfiguracja jest zapisywana automatycznie.
    - **Kimi Coding**: konfiguracja jest zapisywana automatycznie.
    - Więcej szczegółów: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Pomiń**: brak skonfigurowanego uwierzytelniania.
    - Wybierz domyślny model spośród wykrytych opcji (lub wprowadź dostawcę/model ręcznie).
    - Kreator uruchamia sprawdzenie modelu i ostrzega, jeśli skonfigurowany model jest nieznany lub brakuje uwierzytelniania.
    - Poświadczenia OAuth znajdują się w `~/.openclaw/credentials/oauth.json`; profile uwierzytelniania w `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (klucze API + OAuth).
    - Więcej szczegółów: [/concepts/oauth](/concepts/oauth)    
<Note>
    Wskazówka dla trybu headless/serwerowego: ukończ OAuth na maszynie z przeglądarką, a następnie skopiuj
    `~/.openclaw/credentials/oauth.json` (lub `$OPENCLAW_STATE_DIR/credentials/oauth.json`) na
    host gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - Domyślny `~/.openclaw/workspace` (konfigurowalne).
    - Inicjuje pliki obszaru roboczego potrzebne do rytuału bootstrapu agenta.
    - Pełny układ obszaru roboczego + przewodnik kopii zapasowych: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, bindowanie, tryb uwierzytelniania, ekspozycja Tailscale.
    - Rekomendacja uwierzytelniania: zachowaj **Token** nawet dla loopback, aby lokalni klienci WS musieli się uwierzytelniać.
    - Wyłącz uwierzytelnianie tylko wtedy, gdy w pełni ufasz każdemu lokalnemu procesowi.
    - Powiązania inne niż loopback nadal wymagają uwierzytelniania.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): opcjonalne logowanie QR.
    - [Telegram](/channels/telegram): token bota.
    - [Discord](/channels/discord): token bota.
    - [Google Chat](/channels/googlechat): JSON konta usługi + audience webhooka.
    - [Mattermost](/channels/mattermost) (wtyczka): token bota + bazowy URL.
    - [Signal](/channels/signal): opcjonalna instalacja `signal-cli` + konfiguracja konta.
    - [BlueBubbles](/channels/bluebubbles): **zalecane dla iMessage**; URL serwera + hasło + webhook.
    - [iMessage](/channels/imessage): przestarzała ścieżka CLI `imsg` + dostęp do DB.
    - Bezpieczeństwo DM-ów: domyślnie parowanie. Pierwsza wiadomość DM wysyła kod; zatwierdź przez `openclaw pairing approve <channel><code>` lub użyj list dozwolonych.
  </Step><code>` lub użyj list dozwolonych.
  </Step>
  <Step title="Instalacja demona">
    - macOS: LaunchAgent
      - Wymaga zalogowanej sesji użytkownika; dla trybu headless użyj niestandardowego LaunchDaemon (nie jest dostarczany).
    - Linux (oraz Windows przez WSL2): jednostka użytkownika systemd
      - Kreator próbuje włączyć lingering przez `loginctl enable-linger <user>`, aby Gateway pozostał uruchomiony po wylogowaniu.
      - Może poprosić o sudo (zapisuje `/var/lib/systemd/linger`); najpierw próbuje bez sudo.
    - **Wybór środowiska uruchomieniowego:** Node (zalecane; wymagane dla WhatsApp/Telegram). Bun jest **niezalecany**.
  </Step>
  <Step title="Kontrola zdrowia">
    - Uruchamia Gateway (jeśli potrzeba) i wykonuje `openclaw health`.
    - Wskazówka: `openclaw status --deep` dodaje sondy zdrowia gateway do wyjścia statusu (wymaga osiągalnego gateway).
  </Step>
  <Step title="Skills (zalecane)">
    - Odczytuje dostępne Skills i sprawdza wymagania.
    - Pozwala wybrać menedżera węzłów: **npm / pnpm** (bun niezalecany).
    - Instaluje opcjonalne zależności (niektóre używają Homebrew na macOS).
  </Step>
  <Step title="Zakończenie">
    - Podsumowanie + następne kroki, w tym aplikacje iOS/Android/macOS dla dodatkowych funkcji.
  </Step>
</Steps>

<Note>
Jeśli nie wykryto GUI, kreator wypisuje instrukcje przekierowania portów SSH dla Control UI zamiast otwierania przeglądarki.
Jeśli brakuje zasobów Control UI, kreator próbuje je zbudować; mechanizm awaryjny to `pnpm ui:build` (automatyczna instalacja zależności UI).
</Note>

## Tryb nieinteraktywny

Użyj `--non-interactive`, aby zautomatyzować lub skryptować onboarding:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Dodaj `--json` dla podsumowania w formacie nadającym się do odczytu maszynowego.

<Note>
`--json` **nie** oznacza trybu nieinteraktywnego. Do skryptów użyj `--non-interactive` (oraz `--workspace`).
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Dodawanie agenta (tryb nieinteraktywny)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## RPC kreatora Gateway

Gateway udostępnia przepływ kreatora przez RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Klienci (aplikacja macOS, Control UI) mogą renderować kroki bez ponownej implementacji logiki onboardingu.

## Konfiguracja Signal (signal-cli)

Kreator może zainstalować `signal-cli` z wydań GitHub:

- Pobiera odpowiedni zasób wydania.
- Zapisuje go w `~/.openclaw/tools/signal-cli/<version>/`.
- Zapisuje `channels.signal.cliPath` do Twojej konfiguracji.

Uwagi:

- Wersje JVM wymagają **Java 21**.
- Wersje natywne są używane, gdy są dostępne.
- Windows używa WSL2; instalacja signal-cli przebiega zgodnie z przepływem Linux wewnątrz WSL.

## Co zapisuje kreator

Typowe pola w `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (jeśli wybrano Minimax)
- `gateway.*` (tryb, bind, uwierzytelnianie, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Listy dozwolonych kanałów (Slack/Discord/Matrix/Microsoft Teams), gdy zdecydujesz się na nie podczas promptów (nazwy są rozwiązywane do identyfikatorów, gdy to możliwe).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` zapisuje `agents.list[]` oraz opcjonalne `bindings`.

Poświadczenia WhatsApp trafiają do `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sesje są przechowywane w `~/.openclaw/agents/<agentId>/sessions/`.

Niektóre kanały są dostarczane jako wtyczki. Gdy wybierzesz jedną z nich podczas onboardingu, kreator
poprosi o jej instalację (npm lub ścieżka lokalna), zanim będzie można ją skonfigurować.

## Powiązana dokumentacja

- Przegląd kreatora: [Onboarding Wizard](/start/wizard)
- Onboarding aplikacji macOS: [Onboarding](/start/onboarding)
- Referencja konfiguracji: [Gateway configuration](/gateway/configuration)
- Dostawcy: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
