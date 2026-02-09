---
summary: "Status der Google-Chat-App-Unterstützung, Funktionen und Konfiguration"
read_when:
  - Arbeiten an Google-Chat-Kanal-Funktionen
title: "Google Chat"
---

# Google Chat (Chat API)

Status: bereit für Direktnachrichten + Spaces über Google-Chat-API-Webhooks (nur HTTP).

## Schnellstart (für Einsteiger)

1. Erstellen Sie ein Google-Cloud-Projekt und aktivieren Sie die **Google Chat API**.
   - Gehen Sie zu: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Aktivieren Sie die API, falls sie noch nicht aktiviert ist.
2. Erstellen Sie ein **Servicekonto**:
   - Klicken Sie auf **Anmeldedaten erstellen** > **Servicekonto**.
   - Benennen Sie es beliebig (z. B. `openclaw-chat`).
   - Lassen Sie die Berechtigungen leer (**Weiter**).
   - Lassen Sie die Prinzipale mit Zugriff leer (**Fertig**).
3. Erstellen und laden Sie den **JSON-Schlüssel** herunter:
   - Klicken Sie in der Liste der Servicekonten auf das soeben erstellte Konto.
   - Wechseln Sie zum Tab **Schlüssel**.
   - Klicken Sie auf **Schlüssel hinzufügen** > **Neuen Schlüssel erstellen**.
   - Wählen Sie **JSON** und klicken Sie auf **Erstellen**.
4. Speichern Sie die heruntergeladene JSON-Datei auf Ihrem Gateway-Host (z. B. `~/.openclaw/googlechat-service-account.json`).
5. Erstellen Sie eine Google-Chat-App in der [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Füllen Sie die **Anwendungsinformationen** aus:
     - **App-Name**: (z. B. `OpenClaw`)
     - **Avatar-URL**: (z. B. `https://openclaw.ai/logo.png`)
     - **Beschreibung**: (z. B. `Personal AI Assistant`)
   - Aktivieren Sie **Interaktive Funktionen**.
   - Aktivieren Sie unter **Funktionalität** die Option **Spaces und Gruppenkonversationen beitreten**.
   - Wählen Sie unter **Verbindungseinstellungen** **HTTP-Endpunkt-URL**.
   - Wählen Sie unter **Trigger** **Eine gemeinsame HTTP-Endpunkt-URL für alle Trigger verwenden** und setzen Sie diese auf die öffentliche URL Ihres Gateways, gefolgt von `/googlechat`.
     - _Tipp: Führen Sie `openclaw status` aus, um die öffentliche URL Ihres Gateways zu ermitteln._
   - Aktivieren Sie unter **Sichtbarkeit** **Diese Chat-App für bestimmte Personen und Gruppen in &lt;Your Domain&gt; verfügbar machen**.
   - Geben Sie Ihre E-Mail-Adresse (z. B. `user@example.com`) in das Textfeld ein.
   - Klicken Sie unten auf **Speichern**.
6. **App-Status aktivieren**:
   - **Aktualisieren Sie die Seite** nach dem Speichern.
   - Suchen Sie den Abschnitt **App-Status** (meist oben oder unten nach dem Speichern).
   - Ändern Sie den Status auf **Live – für Nutzer verfügbar**.
   - Klicken Sie erneut auf **Speichern**.
7. Konfigurieren Sie OpenClaw mit dem Pfad zum Servicekonto + der Webhook-Audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Oder Konfiguration: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Legen Sie den Webhook-Audience-Typ + -Wert fest (entsprechend Ihrer Chat-App-Konfiguration).
9. Starten Sie das Gateway. Google Chat sendet POST-Anfragen an Ihren Webhook-Pfad.

## Zu Google Chat hinzufügen

Sobald das Gateway läuft und Ihre E-Mail-Adresse zur Sichtbarkeitsliste hinzugefügt wurde:

1. Gehen Sie zu [Google Chat](https://chat.google.com/).
2. Klicken Sie auf das **+** (Plus)-Symbol neben **Direktnachrichten**.
3. Geben Sie in der Suchleiste (wo Sie normalerweise Personen hinzufügen) den **App-Namen** ein, den Sie in der Google Cloud Console konfiguriert haben.
   - **Hinweis**: Der Bot erscheint _nicht_ in der „Marketplace“-Übersicht, da es sich um eine private App handelt. Sie müssen ihn über die Suche nach Namen finden.
4. Wählen Sie Ihren Bot aus den Ergebnissen aus.
5. Klicken Sie auf **Hinzufügen** oder **Chat**, um eine 1:1-Unterhaltung zu starten.
6. Senden Sie „Hello“, um den Assistenten auszulösen!

## Öffentliche URL (nur Webhook)

Google-Chat-Webhooks erfordern einen öffentlichen HTTPS-Endpunkt. Aus Sicherheitsgründen **exponieren Sie nur den Pfad `/googlechat`** ins Internet. Halten Sie das OpenClaw-Dashboard und andere sensible Endpunkte in Ihrem privaten Netzwerk.

### Option A: Tailscale Funnel (empfohlen)

Verwenden Sie Tailscale Serve für das private Dashboard und Funnel für den öffentlichen Webhook-Pfad. So bleibt `/` privat, während nur `/googlechat` exponiert wird.

1. **Prüfen Sie, an welche Adresse Ihr Gateway gebunden ist:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Notieren Sie die IP-Adresse (z. B. `127.0.0.1`, `0.0.0.0` oder Ihre Tailscale-IP wie `100.x.x.x`).

2. **Dashboard nur im Tailnet verfügbar machen (Port 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Nur den Webhook-Pfad öffentlich exponieren:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Node für Funnel-Zugriff autorisieren:**
   Falls Sie dazu aufgefordert werden, besuchen Sie die in der Ausgabe angezeigte Autorisierungs-URL, um Funnel für diesen Node in Ihrer Tailnet-Richtlinie zu aktivieren.

5. **Konfiguration überprüfen:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Ihre öffentliche Webhook-URL lautet:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Ihr privates Dashboard bleibt ausschließlich im Tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Verwenden Sie die öffentliche URL (ohne `:8443`) in der Google-Chat-App-Konfiguration.

> Hinweis: Diese Konfiguration bleibt über Neustarts hinweg erhalten. Um sie später zu entfernen, führen Sie `tailscale funnel reset` und `tailscale serve reset` aus.

### Option B: Reverse Proxy (Caddy)

Wenn Sie einen Reverse Proxy wie Caddy verwenden, leiten Sie nur den spezifischen Pfad weiter:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Mit dieser Konfiguration wird jede Anfrage an `your-domain.com/` ignoriert oder mit 404 beantwortet, während `your-domain.com/googlechat` sicher an OpenClaw weitergeleitet wird.

### Option C: Cloudflare Tunnel

Konfigurieren Sie die Ingress-Regeln Ihres Tunnels so, dass nur der Webhook-Pfad weitergeleitet wird:

- **Pfad**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Standardregel**: HTTP 404 (Not Found)

## Wie es funktioniert

1. Google Chat sendet Webhook-POSTs an das Gateway. Jede Anfrage enthält einen `Authorization: Bearer <token>`-Header.
2. OpenClaw verifiziert das Token anhand der konfigurierten `audienceType` + `audience`:
   - `audienceType: "app-url"` → Audience ist Ihre HTTPS-Webhook-URL.
   - `audienceType: "project-number"` → Audience ist die Cloud-Projektnummer.
3. Nachrichten werden nach Space geroutet:
   - Direktnachrichten verwenden den Sitzungsschlüssel `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Spaces verwenden den Sitzungsschlüssel `agent:<agentId>:googlechat:group:<spaceId>`.
4. Der Zugriff auf Direktnachrichten ist standardmäßig gekoppelt. Unbekannte Absender erhalten einen Kopplungscode; genehmigen Sie mit:
   - `openclaw pairing approve googlechat <code>`
5. Gruppenspaces erfordern standardmäßig eine @-Erwähnung. Verwenden Sie `botUser`, wenn die Erkennung von Erwähnungen den Benutzernamen der App benötigt.

## Ziele

Verwenden Sie diese Kennungen für Zustellung und Allowlists:

- Direktnachrichten: `users/<userId>` oder `users/<email>` (E-Mail-Adressen werden akzeptiert).
- Spaces: `spaces/<spaceId>`.

## Konfigurations-Highlights

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Hinweise:

- Servicekonto-Anmeldedaten können auch inline mit `serviceAccount` (JSON-String) übergeben werden.
- Der Standard-Webhook-Pfad ist `/googlechat`, wenn `webhookPath` nicht gesetzt ist.
- Reaktionen sind über das Werkzeug `reactions` und `channels action` verfügbar, wenn `actions.reactions` aktiviert ist.
- `typingIndicator` unterstützt `none`, `message` (Standard) und `reaction` (Reaktion erfordert Benutzer-OAuth).
- Anhänge werden über die Chat API heruntergeladen und in der Medien-Pipeline gespeichert (Größe begrenzt durch `mediaMaxMb`).

## Fehlerbehebung

### 405 Method Not Allowed

Wenn der Google Cloud Logs Explorer Fehler wie die folgenden anzeigt:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Bedeutet dies, dass der Webhook-Handler nicht registriert ist. Häufige Ursachen:

1. **Kanal nicht konfiguriert**: Der Abschnitt `channels.googlechat` fehlt in Ihrer Konfiguration. Prüfen Sie mit:

   ```bash
   openclaw config get channels.googlechat
   ```

   Wenn „Config path not found“ zurückgegeben wird, fügen Sie die Konfiguration hinzu (siehe [Konfigurations-Highlights](#konfigurations-highlights)).

2. **Plugin nicht aktiviert**: Prüfen Sie den Plugin-Status:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Wenn „disabled“ angezeigt wird, fügen Sie `plugins.entries.googlechat.enabled: true` zu Ihrer Konfiguration hinzu.

3. **Gateway nicht neu gestartet**: Starten Sie das Gateway nach dem Hinzufügen der Konfiguration neu:

   ```bash
   openclaw gateway restart
   ```

Überprüfen Sie, ob der Kanal läuft:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Weitere Probleme

- Prüfen Sie `openclaw channels status --probe` auf Authentifizierungsfehler oder fehlende Audience-Konfiguration.
- Wenn keine Nachrichten ankommen, bestätigen Sie die Webhook-URL + Ereignisabonnements der Chat-App.
- Wenn Erwähnungs-Gating Antworten blockiert, setzen Sie `botUser` auf den Benutzerressourcennamen der App und prüfen Sie `requireMention`.
- Verwenden Sie `openclaw logs --follow`, während Sie eine Testnachricht senden, um zu sehen, ob Anfragen das Gateway erreichen.

Zugehörige Dokumente:

- [Gateway-Konfiguration](/gateway/configuration)
- [Sicherheit](/gateway/security)
- [Reaktionen](/tools/reactions)
