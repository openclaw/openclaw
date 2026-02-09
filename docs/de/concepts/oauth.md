---
summary: "OAuth in OpenClaw: Token-Austausch, Speicherung und Muster für mehrere Konten"
read_when:
  - Sie möchten OAuth in OpenClaw end-to-end verstehen
  - Sie stoßen auf Probleme mit Token-Invalidierung / Abmeldung
  - Sie möchten Setup-Token- oder OAuth-Auth-Flows
  - Sie möchten mehrere Konten oder Profil-Routing
title: "OAuth"
---

# OAuth

OpenClaw unterstützt „Subscription-Auth“ via OAuth für Anbieter, die dies anbieten (insbesondere **OpenAI Codex (ChatGPT OAuth)**). Für Anthropic-Abonnements verwenden Sie den **setup-token**-Flow. Diese Seite erklärt:

- wie der OAuth-**Token-Austausch** funktioniert (PKCE)
- wo Tokens **gespeichert** werden (und warum)
- wie **mehrere Konten** gehandhabt werden (Profile + sitzungsbezogene Overrides)

OpenClaw unterstützt außerdem **Anbieter-Plugins**, die ihre eigenen OAuth- oder API‑Schlüssel-
Flows mitbringen. Führen Sie diese aus über:

```bash
openclaw models auth login --provider <id>
```

## The token sink (why it exists)

OAuth-Anbieter stellen während Login-/Refresh-Flows häufig ein **neues Refresh-Token** aus. Einige Anbieter (oder OAuth-Clients) können ältere Refresh-Tokens ungültig machen, wenn für denselben Benutzer/dieselbe App ein neues ausgegeben wird.

Praktisches Symptom:

- Sie melden sich über OpenClaw _und_ über Claude Code / Codex CLI an → eines davon wird später zufällig „abgemeldet“

Um dies zu reduzieren, behandelt OpenClaw `auth-profiles.json` als **Token-Senke**:

- die Runtime liest Anmeldedaten aus **einer einzigen Quelle**
- wir können mehrere Profile vorhalten und deterministisch routen

## Storage (where tokens live)

Secrets werden **pro Agent** gespeichert:

- Auth-Profile (OAuth + API-Schlüssel): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Runtime-Cache (automatisch verwaltet; nicht bearbeiten): `~/.openclaw/agents/<agentId>/agent/auth.json`

Legacy-Datei nur zum Import (weiterhin unterstützt, aber nicht der Hauptspeicher):

- `~/.openclaw/credentials/oauth.json` (bei der ersten Verwendung in `auth-profiles.json` importiert)

All dies berücksichtigt außerdem `$OPENCLAW_STATE_DIR` (Override des State-Verzeichnisses). Vollständige Referenz: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

Führen Sie `claude setup-token` auf einem beliebigen Rechner aus und fügen Sie es anschließend in OpenClaw ein:

```bash
openclaw models auth setup-token --provider anthropic
```

Wenn Sie das Token anderswo generiert haben, fügen Sie es manuell ein:

```bash
openclaw models auth paste-token --provider anthropic
```

Verifizieren:

```bash
openclaw models status
```

## OAuth exchange (how login works)

Die interaktiven Login-Flows von OpenClaw sind in `@mariozechner/pi-ai` implementiert und in die Assistenten/Befehle eingebunden.

### Anthropic (Claude Pro/Max) setup-token

Flussform:

1. führen Sie `claude setup-token` aus
2. fügen Sie das Token in OpenClaw ein
3. als Token-Auth-Profil speichern (kein Refresh)

Der Assistentenpfad ist `openclaw onboard` → Auth-Auswahl `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Ablauf (PKCE):

1. PKCE-Verifier/Challenge + zufälligen `state` erzeugen
2. `https://auth.openai.com/oauth/authorize?...` öffnen
3. versuchen, den Callback auf `http://127.0.0.1:1455/auth/callback` abzufangen
4. falls der Callback nicht binden kann (oder Sie remote/headless sind), fügen Sie die Redirect-URL/den Code ein
5. Austausch bei `https://auth.openai.com/oauth/token`
6. `accountId` aus dem Access-Token extrahieren und `{ access, refresh, expires, accountId }` speichern

Der Assistentenpfad ist `openclaw onboard` → Auth-Auswahl `openai-codex`.

## Refresh + expiry

Profile speichern einen `expires`-Zeitstempel.

Zur Laufzeit:

- wenn `expires` in der Zukunft liegt → gespeichertes Access-Token verwenden
- wenn abgelaufen → Refresh (unter Dateisperre) und Überschreiben der gespeicherten Anmeldedaten

Der Refresh-Flow ist automatisch; in der Regel müssen Sie Tokens nicht manuell verwalten.

## Multiple accounts (profiles) + routing

Zwei Muster:

### 1. Bevorzugt: getrennte Agenten

Wenn „privat“ und „geschäftlich“ niemals interagieren sollen, verwenden Sie isolierte Agenten (separate Sitzungen + Anmeldedaten + Workspace):

```bash
openclaw agents add work
openclaw agents add personal
```

Konfigurieren Sie dann die Authentifizierung pro Agent (Assistent) und routen Sie Chats an den richtigen Agenten.

### 2. Erweitert: mehrere Profile in einem Agenten

`auth-profiles.json` unterstützt mehrere Profil-IDs für denselben Anbieter.

Wählen Sie, welches Profil verwendet wird:

- global über die Konfigurationsreihenfolge (`auth.order`)
- pro Sitzung über `/model ...@<profileId>`

Beispiel (Sitzungs-Override):

- `/model Opus@anthropic:work`

So sehen Sie, welche Profil-IDs existieren:

- `openclaw channels list --json` (zeigt `auth[]`)

Verwandte Dokumente:

- [/concepts/model-failover](/concepts/model-failover) (Rotation + Cooldown-Regeln)
- [/tools/slash-commands](/tools/slash-commands) (Befehlsschnittstelle)
