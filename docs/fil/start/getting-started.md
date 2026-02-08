---
summary: "I-install ang OpenClaw at patakbuhin ang iyong unang chat sa loob ng ilang minuto."
read_when:
  - Unang beses na setup mula sa zero
  - Gusto mo ang pinakamabilis na daan papunta sa gumaganang chat
title: "Pagsisimula"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:00Z
---

# Pagsisimula

Layunin: mula zero hanggang sa unang gumaganang chat na may minimal na setup.

<Info>
Pinakamabilis na chat: buksan ang Control UI (hindi kailangan ng channel setup). Patakbuhin ang `openclaw dashboard`
at makipag-chat sa browser, o buksan ang `http://127.0.0.1:18789/` sa
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">host ng Gateway</Tooltip>.
Docs: [Dashboard](/web/dashboard) at [Control UI](/web/control-ui).
</Info>

## Mga paunang kinakailangan

- Node 22 o mas bago

<Tip>
Suriin ang iyong bersyon ng Node gamit ang `node --version` kung hindi ka sigurado.
</Tip>

## Mabilis na setup (CLI)

<Steps>
  <Step title="I-install ang OpenClaw (inirerekomenda)">
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
    Iba pang mga paraan ng pag-install at mga kinakailangan: [Install](/install).
    </Note>

  </Step>
  <Step title="Patakbuhin ang onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    Kino-configure ng wizard ang auth, mga setting ng Gateway, at mga opsyonal na channel.
    Tingnan ang [Onboarding Wizard](/start/wizard) para sa mga detalye.

  </Step>
  <Step title="Suriin ang Gateway">
    Kung na-install mo ang service, dapat ay tumatakbo na ito:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Buksan ang Control UI">
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
  <Accordion title="Patakbuhin ang Gateway sa foreground">
    Kapaki-pakinabang para sa mabilisang mga test o pag-troubleshoot.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Magpadala ng test na mensahe">
    Nangangailangan ng naka-configure na channel.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Lumalim pa

<Columns>
  <Card title="Onboarding Wizard (mga detalye)" href="/start/wizard">
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
