---
summary: "I-install ang OpenClaw at patakbuhin ang iyong unang chat sa loob ng ilang minuto."
read_when:
  - Unang beses na setup mula sa zero
  - Gusto mo ang pinakamabilis na daan papunta sa gumaganang chat
title: "Pagsisimula"
---

# Pagsisimula

Layunin: mula zero hanggang sa unang gumaganang chat na may minimal na setup.

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `openclaw dashboard`
and chat in the browser, or open `http://127.0.0.1:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">host ng Gateway</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

## Mga paunang kinakailangan

- Node 22 o mas bago

<Tip>
Suriin ang iyong bersyon ng Node gamit ang `node --version` kung hindi ka sigurado.
</Tip>

## Mabilis na setup (CLI)

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
    Iba pang mga paraan ng pag-install at mga kinakailangan: [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    Kino-configure ng wizard ang auth, mga setting ng Gateway, at mga opsyonal na channel.
    Tingnan ang [Onboarding Wizard](/start/wizard) para sa mga detalye.
    ```

  </Step>
  <Step title="Check the Gateway">
    Kung na-install mo ang service, dapat ay tumatakbo na ito:

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
Kung naglo-load ang Control UI, handa na ang iyong Gateway para gamitin.
</Check>

## Opsyonal na mga pagsusuri at dagdag

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Kapaki-pakinabang para sa mabilisang mga test o pag-troubleshoot.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Nangangailangan ng naka-configure na channel.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Lumalim pa

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Kumpletong sanggunian ng CLI wizard at mga advanced na opsyon.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    First run flow para sa macOS app.
  </Card>
</Columns>

## Ano ang magkakaroon ka

- Isang tumatakbong Gateway
- Naka-configure na auth
- Access sa Control UI o isang nakakonektang channel

## Mga susunod na hakbang

- Kaligtasan ng DM at mga approval: [Pairing](/channels/pairing)
- Kumonekta ng mas maraming channel: [Channels](/channels)
- Mga advanced na workflow at mula sa source: [Setup](/start/setup)
