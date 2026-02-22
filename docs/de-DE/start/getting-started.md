---
read_when:
  - Ersteinrichtung von Grund auf
  - Kürzester Weg zu einem funktionierenden Chat
summary: OpenClaw installieren und in wenigen Minuten den ersten Chat starten.
title: Einstieg
---

# Einstieg

Ziel: Von Null zu einem funktionierenden Chat mit minimalem Setup.

<Info>
Schnellster Weg zum ersten Chat: Control UI öffnen, kein Channel-Setup nötig. Führe `openclaw dashboard` aus und chatte im Browser, oder öffne auf dem <Tooltip headline="Gateway-Host" tip="Maschine, auf der der OpenClaw-Gateway-Dienst läuft.">Gateway-Host</Tooltip> `http://127.0.0.1:18789/`.
Doku: [Dashboard](/web/dashboard) und [Control UI](/web/control-ui).
</Info>

## Voraussetzungen

- Node 22 oder neuer

<Tip>
Wenn du dir unsicher bist, prüfe die Node-Version mit `node --version`.
</Tip>

## Schnelles Setup (CLI)

<Steps>
  <Step title="OpenClaw installieren (empfohlen)">
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
    Weitere Installationswege und Anforderungen: [Installieren](/install).
    </Note>

  </Step>
  <Step title="Onboarding-Wizard starten">
    ```bash
    openclaw onboard --install-daemon
    ```

    Der Wizard richtet Auth, Gateway und optional Channels ein.
    Mehr dazu: [Onboarding-Wizard](/start/wizard).

  </Step>
  <Step title="Gateway prüfen">
    Wenn du den Dienst installiert hast, sollte er bereits laufen:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI öffnen">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Wenn das Control UI lädt, ist das Gateway einsatzbereit.
</Check>

## Optionale Prüfungen und Zusatzfunktionen

<AccordionGroup>
  <Accordion title="Gateway im Vordergrund starten">
    Praktisch für schnelle Tests oder Troubleshooting.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Testnachricht senden">
    Benötigt konfigurierte Channels.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Mehr Details

<Columns>
  <Card title="Onboarding-Wizard im Detail" href="/start/wizard">
    Vollständige CLI-Wizard-Referenz und erweiterte Optionen.
  </Card>
  <Card title="macOS-App-Onboarding" href="/start/onboarding">
    First-Run-Flow der macOS-App.
  </Card>
</Columns>

## Nach dem Abschluss

- Gateway läuft
- Auth ist eingerichtet
- Control UI-Zugriff oder verbundene Channels

## Nächste Schritte

- DM-Sicherheit und Freigaben: [Pairing](/channels/pairing)
- Weitere Channels verbinden: [Channels](/channels)
- Fortgeschrittene Workflows und Build aus Source: [Setup](/start/setup)
