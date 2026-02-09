---
summary: "Installera OpenClaw och kör din första chatt på några minuter."
read_when:
  - Förstagångskonfigurering från noll
  - Du vill ha den snabbaste vägen till en fungerande chatt
title: "Kom igång"
---

# Kom igång

Mål: gå från noll till en första fungerande chatt med minimal konfigurering.

<Info>
Snabbaste chatten: öppna Control UI (ingen kanal installation behövs). Kör 'openclaw dashboard'
och chatta i webbläsaren, eller öppna 'http://127.0.0.1:18789/' på
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway-värden</Tooltip>.
Dokument: [Dashboard](/web/dashboard) och [Control UI](/web/control-ui).
</Info>

## Förutsättningar

- Node 22 eller nyare

<Tip>
Kontrollera din Node-version med `node --version` om du är osäker.
</Tip>

## Snabbstart (CLI)

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
    Andra installationsmetoder och krav: [Installera](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    Guiden konfigurerar autentisering, gateway-inställningar och valfria kanaler.
    Se [Introduktionsguide](/start/wizard) för detaljer.
    ```

  </Step>
  <Step title="Check the Gateway">
    Om du installerade tjänsten ska den redan vara igång:

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
Om Kontroll-UI laddas är din Gateway redo att användas.
</Check>

## Valfria kontroller och tillägg

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Användbart för snabba tester eller felsökning.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Kräver en konfigurerad kanal.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Fördjupa dig

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Fullständig CLI-guide och avancerade alternativ.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    Första körningen-flöde för macOS-appen.
  </Card>
</Columns>

## Vad du kommer att ha

- En körande Gateway
- Autentisering konfigurerad
- Åtkomst till Kontroll-UI eller en ansluten kanal

## Nästa steg

- DM-säkerhet och godkännanden: [Parning](/channels/pairing)
- Anslut fler kanaler: [Kanaler](/channels)
- Avancerade arbetsflöden och från källkod: [Konfigurering](/start/setup)
