---
summary: "Installieren Sie OpenClaw und führen Sie in wenigen Minuten Ihren ersten Chat aus."
read_when:
  - Erstmaliges Setup von Null
  - Sie möchten den schnellsten Weg zu einem funktionierenden Chat
title: "Erste Schritte"
---

# Erste Schritte

Ziel: Mit minimalem Setup von null zu einem ersten funktionierenden Chat gelangen.

<Info>
Schnellster Chat: Öffnen Sie die Control UI (keine Kanal-Einrichtung erforderlich). Führen Sie `openclaw dashboard` aus
und chatten Sie im Browser, oder öffnen Sie `http://127.0.0.1:18789/` auf dem
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">Gateway-Host</Tooltip>.
Dokumentation: [Dashboard](/web/dashboard) und [Control UI](/web/control-ui).
</Info>

## Voraussetzungen

- Node 22 oder neuer

<Tip>
Prüfen Sie Ihre Node-Version mit `node --version`, wenn Sie unsicher sind.
</Tip>

## Schnellstart (CLI)

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
    Weitere Installationsmethoden und Anforderungen: [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    Der Assistent konfiguriert Authentifizierung, Gateway-Einstellungen und optionale Kanäle.
    Siehe [Onboarding Wizard](/start/wizard) für Details.
    ```

  </Step>
  <Step title="Check the Gateway">
    Wenn Sie den Dienst installiert haben, sollte er bereits laufen:

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
Wenn die Control UI lädt, ist Ihr Gateway einsatzbereit.
</Check>

## Optionale Prüfungen und Extras

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Nützlich für schnelle Tests oder zur Fehlerbehebung.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Erfordert einen konfigurierten Kanal.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Tiefer gehen

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Vollständige CLI-Referenz des Assistenten und erweiterte Optionen.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    Erster Startablauf für die macOS-App.
  </Card>
</Columns>

## Was Sie haben werden

- Ein laufendes Gateway
- Konfigurierte Authentifizierung
- Zugriff auf die Control UI oder einen verbundenen Kanal

## Nächste Schritte

- DM-Sicherheit und Freigaben: [Pairing](/channels/pairing)
- Weitere Kanäle verbinden: [Channels](/channels)
- Erweiterte Workflows und aus dem Quellcode: [Setup](/start/setup)
