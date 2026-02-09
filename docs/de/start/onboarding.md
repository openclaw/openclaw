---
summary: "„Onboarding-Ablauf beim ersten Start für OpenClaw (macOS-App)“"
read_when:
  - Entwurf des macOS-Onboarding-Assistenten
  - Implementierung von Authentifizierung oder Identitätseinrichtung
title: "„Onboarding (macOS-App)“"
sidebarTitle: "„Onboarding: macOS-App“"
---

# Onboarding (macOS-App)

Dieses Dokument beschreibt den **aktuellen** Onboarding-Ablauf beim ersten Start. Ziel ist ein
reibungsloses „Tag‑0“-Erlebnis: auswählen, wo der Gateway läuft, Authentifizierung verbinden, den
Assistenten ausführen und den Agenten sich selbst bootstrappen lassen.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Lesen Sie den angezeigten Sicherheitshinweis und entscheiden Sie entsprechend">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Wo läuft der **Gateway**?

- **Dieser Mac (nur lokal):** Das Onboarding kann OAuth-Flows ausführen und Anmeldedaten
  lokal schreiben.
- **Remote (über SSH/Tailnet):** Das Onboarding führt **keine** OAuth-Flows lokal aus;
  Anmeldedaten müssen auf dem Gateway-Host vorhanden sein.
- **Später konfigurieren:** Einrichtung überspringen und die App unkonfiguriert lassen.

<Tip>
**Gateway-Auth-Tipp:**
- Der Assistent erzeugt jetzt auch für loopback ein **Token**, sodass lokale WS-Clients sich authentifizieren müssen.
- Wenn Sie die Authentifizierung deaktivieren, kann sich jeder lokale Prozess verbinden; nutzen Sie dies nur auf vollständig vertrauenswürdigen Maschinen.
- Verwenden Sie ein **Token** für den Zugriff über mehrere Maschinen oder für Non‑loopback‑Bindings.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Wählen Sie, welche Berechtigungen Sie OpenClaw erteilen möchten">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Das Onboarding fordert die benötigten TCC-Berechtigungen an für:

- Automation (AppleScript)
- Mitteilungen
- Bedienungshilfen
- Bildschirmaufnahme
- Mikrofon
- Spracherkennung
- Kamera
- Standort

</Step>
<Step title="CLI">
  <Info>Dieser Schritt ist optional</Info>
  Die App kann die globale `openclaw` CLI über npm/pnpm installieren, sodass Terminal‑Workflows
  und launchd‑Tasks sofort funktionieren.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  Nach der Einrichtung öffnet die App eine dedizierte Onboarding-Chat-Sitzung, damit der Agent sich
  vorstellen und die nächsten Schritte anleiten kann. Dadurch bleibt die Anleitung beim ersten Start
  von Ihrer normalen Unterhaltung getrennt. Siehe [Bootstrapping](/start/bootstrapping) für
  Informationen dazu, was beim ersten Agentenlauf auf dem Gateway-Host passiert.
</Step>
</Steps>
