---
summary: "CLI-Referenz für `openclaw models` (Status/Liste/Setzen/Scannen, Aliase, Fallbacks, Authentifizierung)"
read_when:
  - Sie möchten Standardmodelle ändern oder den Authentifizierungsstatus von Anbietern anzeigen
  - Sie möchten verfügbare Modelle/Anbieter scannen und Authentifizierungsprofile debuggen
title: "models"
---

# `openclaw models`

Modellerkennung, Scannen und Konfiguration (Standardmodell, Fallbacks, Authentifizierungsprofile).

Verwandt:

- Anbieter + Modelle: [Models](/providers/models)
- Einrichtung der Anbieter-Authentifizierung: [Erste Schritte](/start/getting-started)

## Häufige Befehle

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` zeigt das aufgelöste Standardmodell/die Fallbacks sowie eine Authentifizierungsübersicht.
Wenn Nutzungs-Snapshots von Anbietern verfügbar sind, enthält der Abschnitt zum OAuth-/Token-Status
Header zur Anbieternutzung.
Fügen Sie `--probe` hinzu, um Live-Auth-Probes gegen jedes konfigurierte Anbieterprofil auszuführen.
Probes sind echte Anfragen (können Tokens verbrauchen und Rate-Limits auslösen).
Verwenden Sie `--agent <id>`, um den Modell-/Auth-Zustand eines konfigurierten Agenten zu prüfen. Wenn weggelassen,
verwendet der Befehl `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`, falls gesetzt, andernfalls den
konfigurierten Standard-Agenten.

Hinweise:

- `models set <model-or-alias>` akzeptiert `provider/model` oder einen Alias.
- Modell-Referenzen werden durch Aufteilen am **ersten** `/` geparst. Wenn die Modell-ID `/` (OpenRouter-Stil) enthält, fügen Sie das Anbieterpräfix hinzu (Beispiel: `openrouter/moonshotai/kimi-k2`).
- Wenn Sie den Anbieter weglassen, behandelt OpenClaw die Eingabe als Alias oder als Modell für den **Standardanbieter** (funktioniert nur, wenn es kein `/` in der Modell-ID gibt).

### `models status`

Optionen:

- `--json`
- `--plain`
- `--check` (Exit 1=abgelaufen/fehlt, 2=läuft bald ab)
- `--probe` (Live-Probe der konfigurierten Authentifizierungsprofile)
- `--probe-provider <name>` (einen Anbieter prüfen)
- `--probe-profile <id>` (Wiederholung oder durch Komma getrennte Profil-IDs)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (konfigurierte Agenten-ID; überschreibt `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliase + Fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Authentifizierungsprofile

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` führt den Authentifizierungsfluss (OAuth/API-Schlüssel) eines Anbieter-Plugins aus. Verwenden Sie
`openclaw plugins list`, um zu sehen, welche Anbieter installiert sind.

Hinweise:

- `setup-token` fordert zur Eingabe eines Setup-Token-Werts auf (generieren Sie ihn mit `claude setup-token` auf einem beliebigen Rechner).
- `paste-token` akzeptiert eine an anderer Stelle oder durch Automatisierung generierte Token-Zeichenfolge.
