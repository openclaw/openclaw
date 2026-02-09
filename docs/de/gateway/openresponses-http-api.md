---
summary: "Stellt vom Gateway einen OpenResponses-kompatiblen /v1/responses-HTTP-Endpunkt bereit"
read_when:
  - Integration von Clients, die die OpenResponses-API sprechen
  - Sie möchten elementbasierte Eingaben, Client-Werkzeugaufrufe oder SSE-Ereignisse
title: "OpenResponses-API"
---

# OpenResponses-API (HTTP)

Das Gateway von OpenClaw kann einen OpenResponses-kompatiblen `POST /v1/responses`-Endpunkt bereitstellen.

Dieser Endpunkt ist **standardmäßig deaktiviert**. Aktivieren Sie ihn zuerst in der Konfiguration.

- `POST /v1/responses`
- Derselbe Port wie das Gateway (WS- + HTTP-Multiplex): `http://<gateway-host>:<port>/v1/responses`

Unter der Haube werden Anfragen als normaler Gateway-Agent-Lauf ausgeführt (derselbe Codepfad wie
`openclaw agent`), sodass Routing/Berechtigungen/Konfiguration Ihrem Gateway entsprechen.

## Authentifizierung

Verwendet die Gateway-Auth-Konfiguration. Senden Sie ein Bearer-Token:

- `Authorization: Bearer <token>`

Hinweise:

- Wenn `gateway.auth.mode="token"`, verwenden Sie `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`).
- Wenn `gateway.auth.mode="password"`, verwenden Sie `gateway.auth.password` (oder `OPENCLAW_GATEWAY_PASSWORD`).

## Auswahl eines Agenten

Keine benutzerdefinierten Header erforderlich: Kodieren Sie die Agenten-ID im OpenResponses-Feld `model`:

- `model: "openclaw:<agentId>"` (Beispiel: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (Alias)

Oder zielen Sie per Header auf einen bestimmten OpenClaw-Agenten:

- `x-openclaw-agent-id: <agentId>` (Standard: `main`)

Erweitert:

- `x-openclaw-session-key: <sessionKey>`, um das Sitzungsrouting vollständig zu steuern.

## Aktivieren des Endpunkts

Setzen Sie `gateway.http.endpoints.responses.enabled` auf `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Deaktivieren des Endpunkts

Setzen Sie `gateway.http.endpoints.responses.enabled` auf `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Sitzungsverhalten

Standardmäßig ist der Endpunkt **zustandslos pro Anfrage** (bei jedem Aufruf wird ein neuer Sitzungsschlüssel erzeugt).

Wenn die Anfrage eine OpenResponses-Zeichenfolge `user` enthält, leitet das Gateway daraus einen stabilen Sitzungsschlüssel ab,
sodass wiederholte Aufrufe eine Agenten-Sitzung teilen können.

## Anfrageformat (unterstützt)

Die Anfrage folgt der OpenResponses-API mit elementbasierter Eingabe. Aktuell unterstützt:

- `input`: Zeichenfolge oder Array von Item-Objekten.
- `instructions`: wird in den System-Prompt zusammengeführt.
- `tools`: Client-Werkzeugdefinitionen (Funktionswerkzeuge).
- `tool_choice`: Filtern oder Erzwingen von Client-Werkzeugen.
- `stream`: aktiviert SSE-Streaming.
- `max_output_tokens`: Best-Effort-Ausgabelimit (anbieterabhängig).
- `user`: stabiles Sitzungsrouting.

Akzeptiert, aber **derzeit ignoriert**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (Eingabe)

### `message`

Rollen: `system`, `developer`, `user`, `assistant`.

- `system` und `developer` werden an den System-Prompt angehängt.
- Das zuletzt gesendete `user`- oder `function_call_output`-Item wird zur „aktuellen Nachricht“.
- Frühere Benutzer-/Assistenten-Nachrichten werden als Verlauf für den Kontext einbezogen.

### `function_call_output` (zugbasierte Werkzeuge)

Senden Sie Werkzeugergebnisse zurück an das Modell:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` und `item_reference`

Zur Schema-Kompatibilität akzeptiert, aber beim Erstellen des Prompts ignoriert.

## Werkzeuge (clientseitige Funktionswerkzeuge)

Stellen Sie Werkzeuge mit `tools: [{ type: "function", function: { name, description?, parameters? } }]` bereit.

Wenn der Agent entscheidet, ein Werkzeug aufzurufen, enthält die Antwort ein `function_call`-Ausgabe-Item.
Senden Sie anschließend eine Folgeanfrage mit `function_call_output`, um den Zug fortzusetzen.

## Bilder (`input_image`)

Unterstützt Base64- oder URL-Quellen:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Erlaubte MIME-Typen (aktuell): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Maximale Größe (aktuell): 10 MB.

## Dateien (`input_file`)

Unterstützt Base64- oder URL-Quellen:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Erlaubte MIME-Typen (aktuell): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Maximale Größe (aktuell): 5 MB.

Aktuelles Verhalten:

- Dateiinhalte werden dekodiert und dem **System-Prompt** hinzugefügt, nicht der Benutzernachricht,
  sodass sie flüchtig bleiben (nicht im Sitzungsverlauf persistiert).
- PDFs werden nach Text geparst. Wenn wenig Text gefunden wird, werden die ersten Seiten gerastert
  in Bilder umgewandelt und an das Modell übergeben.

Das PDF-Parsen verwendet den Node-freundlichen `pdfjs-dist`-Legacy-Build (ohne Worker). Der moderne
PDF.js-Build erwartet Browser-Worker/DOM-Globals und wird daher im Gateway nicht verwendet.

Standardwerte für das Abrufen von URLs:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Anfragen sind abgesichert (DNS-Auflösung, Blockierung privater IPs, Weiterleitungsobergrenzen, Timeouts).

## Datei- und Bildlimits (Konfiguration)

Standardwerte können unter `gateway.http.endpoints.responses` angepasst werden:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Standardwerte, wenn ausgelassen:

- `maxBodyBytes`: 20 MB
- `files.maxBytes`: 5 MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10 s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4.000.000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10 MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10 s

## Streaming (SSE)

Setzen Sie `stream: true`, um Server-Sent Events (SSE) zu erhalten:

- `Content-Type: text/event-stream`
- Jede Ereigniszeile ist `event: <type>` und `data: <json>`
- Der Stream endet mit `data: [DONE]`

Derzeit ausgegebene Ereignistypen:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (bei Fehler)

## Nutzung

`usage` wird befüllt, wenn der zugrunde liegende Anbieter Token-Zählungen meldet.

## Fehler

Fehler verwenden ein JSON-Objekt wie:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Häufige Fälle:

- `401` fehlende/ungültige Authentifizierung
- `400` ungültiger Anfrage-Body
- `405` falsche Methode

## Beispiele

Ohne Streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
