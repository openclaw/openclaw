---
summary: "Zainstaluj OpenClaw i uruchom swój pierwszy czat w kilka minut."
read_when:
  - Pierwsza konfiguracja od zera
  - Chcesz najszybszej ścieżki do działającego czatu
title: "Pierwsze kroki"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:42Z
---

# Pierwsze kroki

Cel: przejść od zera do pierwszego działającego czatu przy minimalnej konfiguracji.

<Info>
Najszybszy czat: otwórz Control UI (bez potrzeby konfiguracji kanałów). Uruchom `openclaw dashboard`
i czatuj w przeglądarce albo otwórz `http://127.0.0.1:18789/` na
<Tooltip headline="Gateway host" tip="Maszyna uruchamiająca usługę OpenClaw Gateway.">hoście Gateway</Tooltip>.
Dokumentacja: [Dashboard](/web/dashboard) oraz [Control UI](/web/control-ui).
</Info>

## Wymagania wstępne

- Node 22 lub nowszy

<Tip>
Jeśli nie masz pewności, sprawdź wersję Node poleceniem `node --version`.
</Tip>

## Szybka konfiguracja (CLI)

<Steps>
  <Step title="Zainstaluj OpenClaw (zalecane)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Inne metody instalacji i wymagania: [Instalacja](/install).
    </Note>

  </Step>
  <Step title="Uruchom kreator wdrożenia">
    ```bash
    openclaw onboard --install-daemon
    ```

    Kreator konfiguruje uwierzytelnianie, ustawienia Gateway oraz opcjonalne kanały.
    Zobacz [Kreator wdrożenia](/start/wizard), aby poznać szczegóły.

  </Step>
  <Step title="Sprawdź Gateway">
    Jeśli zainstalowałeś usługę, powinna już działać:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Otwórz Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Jeśli Control UI się ładuje, Twój Gateway jest gotowy do użycia.
</Check>

## Opcjonalne sprawdzenia i dodatki

<AccordionGroup>
  <Accordion title="Uruchom Gateway na pierwszym planie">
    Przydatne do szybkich testów lub rozwiązywania problemów.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Wyślij wiadomość testową">
    Wymaga skonfigurowanego kanału.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Zagłęb się dalej

<Columns>
  <Card title="Kreator wdrożenia (szczegóły)" href="/start/wizard">
    Pełne odniesienie do kreatora CLI oraz opcje zaawansowane.
  </Card>
  <Card title="Wdrożenie aplikacji na macOS" href="/start/onboarding">
    Przebieg pierwszego uruchomienia aplikacji na macOS.
  </Card>
</Columns>

## Co będziesz mieć

- Działający Gateway
- Skonfigurowane uwierzytelnianie
- Dostęp do Control UI lub podłączony kanał

## Następne kroki

- Bezpieczeństwo DM-ów i zatwierdzanie: [Parowanie](/channels/pairing)
- Podłącz więcej kanałów: [Kanały](/channels)
- Zaawansowane przepływy pracy i uruchamianie ze źródeł: [Konfiguracja](/start/setup)
