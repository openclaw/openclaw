---
summary: "„Gmail Pub/Sub Push über gogcli in OpenClaw-Webhooks eingebunden“"
read_when:
  - Gmail-Posteingangstrigger mit OpenClaw verdrahten
  - Pub/Sub Push für das Aufwecken von Agenten einrichten
title: "„Gmail PubSub“"
---

# Gmail Pub/Sub -> OpenClaw

Ziel: Gmail-Watch -> Pub/Sub Push -> `gog gmail watch serve` -> OpenClaw-Webhook.

## Voraussetzungen

- `gcloud` installiert und angemeldet ([Installationsanleitung](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) installiert und für das Gmail-Konto autorisiert ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw-Hooks aktiviert (siehe [Webhooks](/automation/webhook)).
- `tailscale` angemeldet ([tailscale.com](https://tailscale.com/)). Die unterstützte Einrichtung verwendet Tailscale Funnel für den öffentlichen HTTPS-Endpunkt.
  Andere Tunneldienste können funktionieren, sind jedoch DIY/nicht unterstützt und erfordern manuelle Verdrahtung.
  Derzeit unterstützen wir Tailscale.

Beispiel-Hook-Konfiguration (Gmail-Preset-Zuordnung aktivieren):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Um die Gmail-Zusammenfassung an eine Chat-Oberfläche zu senden, überschreiben Sie das Preset mit einer Zuordnung,
die `deliver` + optional `channel`/`to` setzt:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Wenn Sie einen festen Kanal möchten, setzen Sie `channel` + `to`. Andernfalls verwendet `channel: "last"`
die letzte Zustellroute (Fallback auf WhatsApp).

Um für Gmail-Läufe ein günstigeres Modell zu erzwingen, setzen Sie `model` in der Zuordnung
(`provider/model` oder Alias). Wenn Sie `agents.defaults.models` erzwingen, fügen Sie es dort hinzu.

Um ein Standardmodell und eine Denkstufe speziell für Gmail-Hooks festzulegen, fügen Sie
`hooks.gmail.model` / `hooks.gmail.thinking` in Ihrer Konfiguration hinzu:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Hinweise:

- Pro Hook überschreiben `model`/`thinking` in der Zuordnung weiterhin diese Standardwerte.
- Fallback-Reihenfolge: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primär (Auth/Rate-Limit/Timeouts).
- Wenn `agents.defaults.models` gesetzt ist, muss das Gmail-Modell in der Allowlist enthalten sein.
- Gmail-Hook-Inhalte werden standardmäßig mit Sicherheitsgrenzen für externe Inhalte umschlossen.
  Zum Deaktivieren (gefährlich) setzen Sie `hooks.gmail.allowUnsafeExternalContent: true`.

Um die Payload-Verarbeitung weiter anzupassen, fügen Sie `hooks.mappings` oder ein JS/TS-Transformationsmodul
unter `hooks.transformsDir` hinzu (siehe [Webhooks](/automation/webhook)).

## Assistent (empfohlen)

Verwenden Sie den OpenClaw-Helfer, um alles miteinander zu verdrahten (installiert Abhängigkeiten unter macOS via brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Standards:

- Verwendet Tailscale Funnel für den öffentlichen Push-Endpunkt.
- Schreibt die `hooks.gmail`-Konfiguration für `openclaw webhooks gmail run`.
- Aktiviert das Gmail-Hook-Preset (`hooks.presets: ["gmail"]`).

Pfad-Hinweis: Wenn `tailscale.mode` aktiviert ist, setzt OpenClaw automatisch
`hooks.gmail.serve.path` auf `/` und hält den öffentlichen Pfad bei
`hooks.gmail.tailscale.path` (Standard `/gmail-pubsub`), da Tailscale
das gesetzte Pfadpräfix vor dem Proxying entfernt.
Wenn das Backend den präfixierten Pfad erhalten soll, setzen Sie
`hooks.gmail.tailscale.target` (oder `--tailscale-target`) auf eine vollständige URL wie
`http://127.0.0.1:8788/gmail-pubsub` und stimmen Sie `hooks.gmail.serve.path` ab.

Möchten Sie einen benutzerdefinierten Endpunkt? Verwenden Sie `--push-endpoint <url>` oder `--tailscale off`.

Plattform-Hinweis: Unter macOS installiert der Assistent `gcloud`, `gogcli` und `tailscale`
über Homebrew; unter Linux installieren Sie diese zuerst manuell.

Gateway-Autostart (empfohlen):

- Wenn `hooks.enabled=true` und `hooks.gmail.account` gesetzt ist, startet das Gateway
  `gog gmail watch serve` beim Booten und erneuert den Watch automatisch.
- Setzen Sie `OPENCLAW_SKIP_GMAIL_WATCHER=1`, um sich abzumelden (nützlich, wenn Sie den Daemon selbst ausführen).
- Führen Sie den manuellen Daemon nicht gleichzeitig aus, sonst kommt es zu
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Manueller Daemon (startet `gog gmail watch serve` + Auto-Erneuerung):

```bash
openclaw webhooks gmail run
```

## Einmalige Einrichtung

1. Wählen Sie das GCP-Projekt aus, **dem der OAuth-Client gehört**, der von `gog` verwendet wird.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Hinweis: Gmail-Watch erfordert, dass das Pub/Sub-Thema im selben Projekt wie der OAuth-Client liegt.

2. APIs aktivieren:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Thema erstellen:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail-Push das Veröffentlichen erlauben:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Watch starten

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Speichern Sie die `history_id` aus der Ausgabe (für Debugging).

## Push-Handler ausführen

Lokales Beispiel (Shared-Token-Auth):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Hinweise:

- `--token` schützt den Push-Endpunkt (`x-gog-token` oder `?token=`).
- `--hook-url` zeigt auf OpenClaw `/hooks/gmail` (zugeordnet; isolierter Lauf + Zusammenfassung an den Hauptlauf).
- `--include-body` und `--max-bytes` steuern den an OpenClaw gesendeten Textausschnitt.

Empfohlen: `openclaw webhooks gmail run` kapselt denselben Ablauf und erneuert den Watch automatisch.

## Handler exponieren (fortgeschritten, nicht unterstützt)

Wenn Sie einen Nicht-Tailscale-Tunnel benötigen, verdrahten Sie ihn manuell und verwenden Sie die öffentliche URL in der Push-
Subscription (nicht unterstützt, ohne Schutzmechanismen):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Verwenden Sie die generierte URL als Push-Endpunkt:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Produktion: Verwenden Sie einen stabilen HTTPS-Endpunkt und konfigurieren Sie Pub/Sub OIDC JWT, dann ausführen:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

Senden Sie eine Nachricht an den überwachten Posteingang:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Watch-Status und Verlauf prüfen:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Fehlerbehebung

- `Invalid topicName`: Projekt-Mismatch (Thema nicht im OAuth-Client-Projekt).
- `User not authorized`: fehlendes `roles/pubsub.publisher` auf dem Thema.
- Leere Nachrichten: Gmail-Push stellt nur `historyId` bereit; Abruf über `gog gmail history`.

## Aufräumen

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
