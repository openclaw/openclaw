---
summary: "Installera OpenClaw och kör din första chatt på några minuter."
read_when:
  - Förstagångskonfigurering från noll
  - Du vill ha den snabbaste vägen till en fungerande chatt
title: "Kom igång"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:32Z
---

# Kom igång

Mål: gå från noll till en första fungerande chatt med minimal konfigurering.

<Info>
Snabbaste chatten: öppna Kontroll-UI (ingen kanal behöver konfigureras). Kör `openclaw dashboard`
och chatta i webbläsaren, eller öppna `http://127.0.0.1:18789/` på
<Tooltip headline="Gateway host" tip="Maskinen som kör OpenClaw gateway-tjänsten.">gateway-värden</Tooltip>.
Dokumentation: [Dashboard](/web/dashboard) och [Control UI](/web/control-ui).
</Info>

## Förutsättningar

- Node 22 eller nyare

<Tip>
Kontrollera din Node-version med `node --version` om du är osäker.
</Tip>

## Snabbstart (CLI)

<Steps>
  <Step title="Installera OpenClaw (rekommenderas)">
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
    Andra installationsmetoder och krav: [Installera](/install).
    </Note>

  </Step>
  <Step title="Kör introduktionsguiden">
    ```bash
    openclaw onboard --install-daemon
    ```

    Guiden konfigurerar autentisering, gateway-inställningar och valfria kanaler.
    Se [Introduktionsguide](/start/wizard) för detaljer.

  </Step>
  <Step title="Kontrollera Gateway">
    Om du installerade tjänsten ska den redan vara igång:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Öppna Kontroll-UI">
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
  <Accordion title="Kör Gateway i förgrunden">
    Användbart för snabba tester eller felsökning.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Skicka ett testmeddelande">
    Kräver en konfigurerad kanal.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Fördjupa dig

<Columns>
  <Card title="Introduktionsguide (detaljer)" href="/start/wizard">
    Fullständig CLI-guide och avancerade alternativ.
  </Card>
  <Card title="Introduktion i macOS-appen" href="/start/onboarding">
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
