---
summary: "Installeer OpenClaw en voer binnen enkele minuten je eerste chat uit."
read_when:
  - Eerste installatie vanaf nul
  - Je wilt de snelste route naar een werkende chat
title: "Aan de slag"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:46Z
---

# Aan de slag

Doel: van nul naar een eerste werkende chat met minimale installatie.

<Info>
Snelste chat: open de Control UI (geen kanaalconfiguratie nodig). Voer `openclaw dashboard` uit
en chat in de browser, of open `http://127.0.0.1:18789/` op de
<Tooltip headline="Gateway host" tip="De machine waarop de OpenClaw gateway-service draait.">Gateway-host</Tooltip>.
Documentatie: [Dashboard](/web/dashboard) en [Control UI](/web/control-ui).
</Info>

## Vereisten

- Node 22 of nieuwer

<Tip>
Controleer je Node-versie met `node --version` als je het niet zeker weet.
</Tip>

## Snelle installatie (CLI)

<Steps>
  <Step title="Installeer OpenClaw (aanbevolen)">
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
    Andere installatiemethoden en vereisten: [Installeren](/install).
    </Note>

  </Step>
  <Step title="Start de onboarding-wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    De wizard configureert authenticatie, Gateway-instellingen en optionele kanalen.
    Zie [Onboarding Wizard](/start/wizard) voor details.

  </Step>
  <Step title="Controleer de Gateway">
    Als je de service hebt geïnstalleerd, zou deze al moeten draaien:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Open de Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Als de Control UI laadt, is je Gateway klaar voor gebruik.
</Check>

## Optionele controles en extra’s

<AccordionGroup>
  <Accordion title="Draai de Gateway op de voorgrond">
    Handig voor snelle tests of het oplossen van problemen.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Verstuur een testbericht">
    Vereist een geconfigureerd kanaal.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Ga dieper

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Volledige CLI-wizardreferentie en geavanceerde opties.
  </Card>
  <Card title="macOS-app onboarding" href="/start/onboarding">
    Eerste-runflow voor de macOS-app.
  </Card>
</Columns>

## Wat je hebt

- Een draaiende Gateway
- Authenticatie geconfigureerd
- Toegang tot de Control UI of een verbonden kanaal

## Volgende stappen

- DM-veiligheid en goedkeuringen: [Pairing](/channels/pairing)
- Meer kanalen verbinden: [Kanalen](/channels)
- Geavanceerde workflows en bouwen vanaf de bron: [Installatie](/start/setup)
