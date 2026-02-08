---
summary: "Installieren Sie OpenClaw und führen Sie in wenigen Minuten Ihren ersten Chat aus."
read_when:
  - Ersteinrichtung von Grund auf
  - Sie möchten den schnellsten Weg zu einem funktionierenden Chat
title: "Erste Schritte"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:37:24Z
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
    Weitere Installationsmethoden und Anforderungen: [Install](/install).
    </Note>

  </Step>
  <Step title="Onboarding-Assistent ausführen">
    ```bash
    openclaw onboard --install-daemon
    ```

    Der Assistent konfiguriert Authentifizierung, Gateway-Einstellungen und optionale Kanäle.
    Siehe [Onboarding Wizard](/start/wizard) für Details.

  </Step>
  <Step title="Gateway prüfen">
    Wenn Sie den Dienst installiert haben, sollte er bereits laufen:

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
Wenn die Control UI lädt, ist Ihr Gateway einsatzbereit.
</Check>

## Optionale Prüfungen und Extras

<AccordionGroup>
  <Accordion title="Gateway im Vordergrund ausführen">
    Nützlich für schnelle Tests oder zur Fehlerbehebung.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Testnachricht senden">
    Erfordert einen konfigurierten Kanal.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Weiterführendes

<Columns>
  <Card title="Onboarding Wizard (Details)" href="/start/wizard">
    Vollständige CLI-Referenz des Assistenten und erweiterte Optionen.
  </Card>
  <Card title="macOS-App-Onboarding" href="/start/onboarding">
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
