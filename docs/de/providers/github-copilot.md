---
summary: "Melden Sie sich von OpenClaw aus über den Device-Flow bei GitHub Copilot an"
read_when:
  - Sie möchten GitHub Copilot als Modellanbieter verwenden
  - Sie benötigen den Flow `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## Was ist GitHub Copilot?

GitHub Copilot ist der KI-Codierungsassistent von GitHub. Er bietet Zugriff auf
Copilot-Modelle für Ihr GitHub-Konto und Ihren Tarif. OpenClaw kann Copilot auf
zwei unterschiedliche Arten als Modellanbieter verwenden.

## Zwei Wege, Copilot in OpenClaw zu verwenden

### 1. Integrierter GitHub-Copilot-Anbieter (`github-copilot`)

Verwenden Sie den nativen Device-Login-Flow, um ein GitHub-Token zu erhalten, und
tauschen Sie es aus, wenn OpenClaw ausgeführt wird, gegen Copilot-API-Tokens. Dies
ist der **Standard** und der einfachste Weg, da kein VS Code erforderlich ist.

### 2. Copilot-Proxy-Plugin (`copilot-proxy`)

Verwenden Sie die VS-Code-Erweiterung **Copilot Proxy** als lokale Brücke. OpenClaw kommuniziert mit dem `/v1`-Endpunkt des Proxys und verwendet die
dort konfigurierte Modellliste. Wählen Sie diese Option, wenn Sie Copilot Proxy
bereits in VS Code ausführen oder den Verkehr darüber leiten müssen.
Sie müssen
das Plugin aktivieren und die VS-Code-Erweiterung weiterhin ausführen.

Verwenden Sie GitHub Copilot als Modellanbieter (`github-copilot`). Der
Login-Befehl führt den GitHub-Device-Flow aus, speichert ein Authentifizierungsprofil
und aktualisiert Ihre Konfiguration, um dieses Profil zu verwenden.

## CLI-Einrichtung

```bash
openclaw models auth login-github-copilot
```

Sie werden aufgefordert, eine URL aufzurufen und einen einmaligen Code einzugeben. Lassen Sie das Terminal geöffnet, bis der Vorgang abgeschlossen ist.

### Optionale Flags

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Standardmodell festlegen

```bash
openclaw models set github-copilot/gpt-4o
```

### Konfigurationsausschnitt

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Hinweise

- Erfordert ein interaktives TTY; führen Sie den Befehl direkt in einem Terminal aus.
- Die Verfügbarkeit der Copilot-Modelle hängt von Ihrem Tarif ab; wenn ein Modell
  abgelehnt wird, versuchen Sie eine andere ID (zum Beispiel `github-copilot/gpt-4.1`).
- Der Login speichert ein GitHub-Token im Authentifizierungsprofil-Speicher und
  tauscht es beim Ausführen von OpenClaw gegen ein Copilot-API-Token aus.
