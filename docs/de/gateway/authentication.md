---
summary: "„Modellauthentifizierung: OAuth, API-Schlüssel und Setup-Token“"
read_when:
  - Debugging der Modellauthentifizierung oder des OAuth-Ablaufs
  - Dokumentation der Authentifizierung oder der Speicherung von Anmeldedaten
title: "„Authentifizierung“"
---

# Authentifizierung

OpenClaw unterstützt OAuth und API-Schlüssel für Modellanbieter. Für Anthropic‑Konten empfehlen wir die Verwendung eines **API-Schlüssels**. Für den Zugriff über ein Claude‑Abonnement verwenden Sie das langlebige Token, das mit `claude setup-token` erstellt wird.

Siehe [/concepts/oauth](/concepts/oauth) für den vollständigen OAuth‑Ablauf und das Speicherlayout.

## Empfohlene Anthropic‑Einrichtung (API‑Schlüssel)

Wenn Sie Anthropic direkt verwenden, nutzen Sie einen API‑Schlüssel.

1. Erstellen Sie einen API‑Schlüssel in der Anthropic Console.
2. Legen Sie ihn auf dem **Gateway-Host** (der Maschine, auf der `openclaw gateway` läuft) ab.

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Wenn das Gateway unter systemd/launchd läuft, legen Sie den Schlüssel bevorzugt in `~/.openclaw/.env` ab, damit der Daemon ihn lesen kann:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Starten Sie anschließend den Daemon neu (oder starten Sie Ihren Gateway‑Prozess neu) und prüfen Sie erneut:

```bash
openclaw models status
openclaw doctor
```

Wenn Sie Umgebungsvariablen nicht selbst verwalten möchten, kann der Onboarding‑Assistent API‑Schlüssel für die Verwendung durch den Daemon speichern: `openclaw onboard`.

Siehe [Help](/help) für Details zur Vererbung von Umgebungsvariablen (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic: Setup-Token (Abonnement‑Authentifizierung)

Für Anthropic ist der empfohlene Weg ein **API‑Schlüssel**. Wenn Sie ein Claude‑Abonnement verwenden, wird der Setup‑Token‑Ablauf ebenfalls unterstützt. Führen Sie ihn auf dem **Gateway-Host** aus:

```bash
claude setup-token
```

Fügen Sie ihn anschließend in OpenClaw ein:

```bash
openclaw models auth setup-token --provider anthropic
```

Wenn das Token auf einer anderen Maschine erstellt wurde, fügen Sie es manuell ein:

```bash
openclaw models auth paste-token --provider anthropic
```

Wenn Sie einen Anthropic‑Fehler sehen wie:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…verwenden Sie stattdessen einen Anthropic‑API‑Schlüssel.

Manuelle Token‑Eingabe (beliebiger Anbieter; schreibt `auth-profiles.json` + aktualisiert die Konfiguration):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Automatisierungsfreundliche Prüfung (Beenden mit `1` bei abgelaufen/fehlend, `2` bei bald ablaufend):

```bash
openclaw models status --check
```

Optionale Ops‑Skripte (systemd/Termux) sind hier dokumentiert:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` erfordert ein interaktives TTY.

## Überprüfen des Modellauthentifizierungsstatus

```bash
openclaw models status
openclaw doctor
```

## Legt fest, welche Anmeldeinformationen verwendet werden

### Pro Sitzung (Chat‑Befehl)

Verwenden Sie `/model <alias-or-id>@<profileId>`, um ein bestimmtes Anbieter‑Anmeldeprofil für die aktuelle Sitzung festzulegen (Beispiel‑Profil‑IDs: `anthropic:default`, `anthropic:work`).

Verwenden Sie `/model` (oder `/model list`) für eine kompakte Auswahl; verwenden Sie `/model status` für die vollständige Ansicht (Kandidaten + nächstes Authentifizierungsprofil sowie Anbieter‑Endpunktdetails, wenn konfiguriert).

### Pro Agent (CLI‑Override)

Legen Sie eine explizite Überschreibung der Reihenfolge der Authentifizierungsprofile für einen Agenten fest (gespeichert in dessen `auth-profiles.json`):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Verwenden Sie `--agent <id>`, um einen bestimmten Agenten anzusprechen; lassen Sie es weg, um den konfigurierten Standard‑Agenten zu verwenden.

## Fehlerbehebung

### „No credentials found“

Wenn das Anthropic‑Token‑Profil fehlt, führen Sie `claude setup-token` auf dem **Gateway-Host** aus und prüfen Sie anschließend erneut:

```bash
openclaw models status
```

### Token läuft ab/ist abgelaufen

Führen Sie `openclaw models status` aus, um zu bestätigen, welches Profil abläuft. Wenn das Profil fehlt, führen Sie `claude setup-token` erneut aus und fügen Sie das Token nochmals ein.

## Anforderungen

- Claude Max‑ oder Pro‑Abonnement (für `claude setup-token`)
- Claude Code CLI installiert (Befehl `claude` verfügbar)
