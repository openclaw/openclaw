---
summary: "„Erweiterte Einrichtung und Entwicklungs-Workflows für OpenClaw“"
read_when:
  - Einrichten eines neuen Rechners
  - Sie möchten „neueste + beste Version“, ohne Ihre persönliche Einrichtung zu gefährden
title: "Einrichtung"
---

# Einrichtung

<Note>
Wenn Sie sich zum ersten Mal einrichten, beginnen Sie mit [Erste Schritte](/start/getting-started).
Details zum Assistenten finden Sie unter [Onboarding Wizard](/start/wizard).
</Note>

Zuletzt aktualisiert: 2026-01-01

## TL;DR

- **Anpassungen liegen außerhalb des Repos:** `~/.openclaw/workspace` (Workspace) + `~/.openclaw/openclaw.json` (Konfiguration).
- **Stabiler Workflow:** Installieren Sie die macOS‑App; lassen Sie sie den gebündelten Gateway ausführen.
- **Bleeding‑Edge‑Workflow:** Führen Sie den Gateway selbst über `pnpm gateway:watch` aus und lassen Sie dann die macOS‑App im lokalen Modus andocken.

## Voraussetzungen (von der Quelle)

- Node `>=22`
- `pnpm`
- Docker (optional; nur für containerisierte Einrichtung/E2E — siehe [Docker](/install/docker))

## Strategie für Anpassungen (damit Updates nicht schaden)

Wenn Sie „100 % auf mich zugeschnitten“ _und_ einfache Updates möchten, halten Sie Ihre Anpassungen in:

- **Konfiguration:** `~/.openclaw/openclaw.json` (JSON/JSON5‑ähnlich)
- **Workspace:** `~/.openclaw/workspace` (Skills, Prompts, Memories; als privates Git‑Repo anlegen)

Bootstrap einmal:

```bash
openclaw setup
```

Von innerhalb dieses Repos verwenden Sie den lokalen CLI‑Einstieg:

```bash
openclaw setup
```

Wenn Sie noch keine globale Installation haben, führen Sie es über `pnpm openclaw setup` aus.

## Gateway aus diesem Repo ausführen

Nach `pnpm build` können Sie die paketierte CLI direkt ausführen:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stabiler Workflow (macOS‑App zuerst)

1. Installieren und starten Sie **OpenClaw.app** (Menüleiste).
2. Schließen Sie die Onboarding-/Berechtigungs‑Checkliste ab (TCC‑Abfragen).
3. Stellen Sie sicher, dass der Gateway **Lokal** ist und läuft (die App verwaltet ihn).
4. Verknüpfen Sie Oberflächen (Beispiel: WhatsApp):

```bash
openclaw channels login
```

5. Plausibilitätsprüfung:

```bash
openclaw health
```

Wenn Onboarding in Ihrem Build nicht verfügbar ist:

- Führen Sie `openclaw setup` aus, dann `openclaw channels login`, und starten Sie anschließend den Gateway manuell (`openclaw gateway`).

## Bleeding‑Edge‑Workflow (Gateway im Terminal)

Ziel: Am TypeScript‑Gateway arbeiten, Hot Reload erhalten und die macOS‑App‑UI verbunden halten.

### 0. (Optional) Auch die macOS‑App aus dem Quellcode ausführen

Wenn Sie die macOS‑App ebenfalls auf dem Bleeding Edge möchten:

```bash
./scripts/restart-mac.sh
```

### 1. Dev‑Gateway starten

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` führt den Gateway im Watch‑Modus aus und lädt bei TypeScript‑Änderungen neu.

### 2. macOS‑App auf Ihren laufenden Gateway zeigen lassen

In **OpenClaw.app**:

- Verbindungsmodus: **Lokal**
  Die App dockt an den laufenden Gateway auf dem konfigurierten Port an.

### 3. Verifizieren

- Der Gateway‑Status in der App sollte **„Using existing gateway …“** anzeigen
- Oder per CLI:

```bash
openclaw health
```

### Gewöhnliche Fußwaffen

- **Falscher Port:** Gateway‑WS verwendet standardmäßig `ws://127.0.0.1:18789`; halten Sie App und CLI auf demselben Port.
- **Wo Zustände liegen:**
  - Anmeldedaten: `~/.openclaw/credentials/`
  - Sitzungen: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Anmeldedaten Speicherkarte

Nutzen Sie dies beim Debuggen von Auth oder um zu entscheiden, was gesichert werden soll:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram‑Bot‑Token**: Konfiguration/Umgebungsvariablen oder `channels.telegram.tokenFile`
- **Discord‑Bot‑Token**: Konfiguration/Umgebungsvariablen (Token‑Datei noch nicht unterstützt)
- **Slack‑Tokens**: Konfiguration/Umgebungsvariablen (`channels.slack.*`)
- **Pairing‑Allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Modell‑Auth‑Profile**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy‑OAuth‑Import**: `~/.openclaw/credentials/oauth.json`
  Weitere Details: [Security](/gateway/security#credential-storage-map).

## Aktualisieren (ohne Ihre Einrichtung zu ruinieren)

- Behalten Sie `~/.openclaw/workspace` und `~/.openclaw/` als „Ihre Inhalte“; legen Sie keine persönlichen Prompts/Konfigurationen im `openclaw`‑Repo ab.
- Quellcode aktualisieren: `git pull` + `pnpm install` (wenn sich die Lockfile geändert hat) + weiter `pnpm gateway:watch` verwenden.

## Linux (systemd‑User‑Service)

Linux‑Installationen verwenden einen systemd‑**User**‑Service. Standardmäßig stoppt systemd User‑Services bei Abmeldung/Leerlauf, was den Gateway beendet. Das Onboarding versucht, „Lingering“ für Sie zu aktivieren (kann sudo erfordern). Falls es weiterhin deaktiviert ist, führen Sie aus:

```bash
sudo loginctl enable-linger $USER
```

Für Always‑On‑ oder Multi‑User‑Server erwägen Sie einen **System**‑Service statt eines User‑Services (kein Lingering nötig). Siehe [Gateway runbook](/gateway) für die systemd‑Hinweise.

## Verwandte Dokumente

- [Gateway runbook](/gateway) (Flags, Überwachung, Ports)
- [Gateway configuration](/gateway/configuration) (Konfigurationsschema + Beispiele)
- [Discord](/channels/discord) und [Telegram](/channels/telegram) (Antwort‑Tags + replyToMode‑Einstellungen)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (Gateway‑Lebenszyklus)
