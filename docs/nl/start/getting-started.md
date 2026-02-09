---
summary: "Installeer OpenClaw en voer binnen enkele minuten je eerste chat uit."
read_when:
  - Eerste installatie vanaf nul
  - Je wilt de snelste route naar een werkende chat
title: "Aan de slag"
---

# Aan de slag

Doel: van nul naar een eerste werkende chat met minimale installatie.

<Info>
Snelste chat: open de Control UI (geen kanaalconfiguratie nodig). Voer `openclaw dashboard` uit
en chat in de browser, of open `http://127.0.0.1:18789/` op de
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">Gateway-host</Tooltip>.
Documentatie: [Dashboard](/web/dashboard) en [Control UI](/web/control-ui).
</Info>

## Prereqs

- Node 22 of nieuwer

<Tip>
Controleer je Node-versie met `node --version` als je het niet zeker weet.
</Tip>

## Snelle installatie (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
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

    ```
    <Note>
    Andere installatiemethoden en vereisten: [Installeren](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    De wizard configureert authenticatie, Gateway-instellingen en optionele kanalen.
    Zie [Onboarding Wizard](/start/wizard) voor details.
    ```

  </Step>
  <Step title="Check the Gateway">
    Als je de service hebt geïnstalleerd, zou deze al moeten draaien:

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
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
  <Accordion title="Run the Gateway in the foreground">
    Handig voor snelle tests of het oplossen van problemen.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Vereist een geconfigureerd kanaal.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Dieper gaan

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Volledige CLI-wizardreferentie en geavanceerde opties.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
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
