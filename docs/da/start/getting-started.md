---
summary: "Få OpenClaw installeret, og kør din første chat på få minutter."
read_when:
  - Førstegangsopsætning fra bunden
  - Du vil have den hurtigste vej til en fungerende chat
title: "Kom godt i gang"
---

# Kom godt i gang

Mål: gå fra nul til en første fungerende chat med minimal opsætning.

<Info>
Hurtigste chat: åbne Control UI (ingen kanal setup nødvendig). Kør `openclaw dashboard`
og chat i browseren, eller åbn `http://127.0.0.1:18789/` på
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway-værten</Tooltip>.
Dokumenter: [Dashboard](/web/dashboard) og [Control UI] (/web/control-ui).
</Info>

## Forudsætninger

- Node 22 eller nyere

<Tip>
Tjek din Node-version med `node --version`, hvis du er i tvivl.
</Tip>

## Hurtig opsætning (CLI)

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
    Andre installationsmetoder og krav: [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    Guiden konfigurerer autentificering, gateway-indstillinger og valgfrie kanaler.
    Se [Onboarding Wizard](/start/wizard) for detaljer.
    ```

  </Step>
  <Step title="Check the Gateway">
    Hvis du installerede tjenesten, burde den allerede køre:

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
Hvis Control UI indlæses, er din Gateway klar til brug.
</Check>

## Valgfrie tjek og ekstra funktioner

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Nyttigt til hurtige tests eller fejlfinding.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Kræver en konfigureret kanal.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Gå mere i dybden

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Fuld reference til CLI-guiden og avancerede indstillinger.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    Første kørselsflow for macOS-appen.
  </Card>
</Columns>

## Hvad du vil have

- En kørende Gateway
- Autentificering konfigureret
- Adgang til Control UI eller en tilsluttet kanal

## Næste trin

- DM-sikkerhed og godkendelser: [Pairing](/channels/pairing)
- Tilslut flere kanaler: [Channels](/channels)
- Avancerede arbejdsgange og kørsel fra kilde: [Setup](/start/setup)
