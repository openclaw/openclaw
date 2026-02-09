---
summary: "Stel een OpenResponses-compatibel /v1/responses HTTP-endpoint beschikbaar vanuit de Gateway"
read_when:
  - Clients integreren die de OpenResponses API spreken
  - Je wilt item-gebaseerde invoer, client tool calls of SSE-events
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

De Gateway van OpenClaw kan een OpenResponses-compatibel `POST /v1/responses` endpoint aanbieden.

Dit endpoint is **standaard uitgeschakeld**. Schakel het eerst in via de config.

- `POST /v1/responses`
- Zelfde poort als de Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/v1/responses`

Onder de motorkap worden verzoeken uitgevoerd als een normale Gateway-agentrun (hetzelfde codepad als
`openclaw agent`), dus routering/rechten/config komen overeen met je Gateway.

## Authenticatie

Gebruikt de Gateway-authenticatieconfiguratie. Stuur een bearer token:

- `Authorization: Bearer <token>`

Notities:

- Wanneer `gateway.auth.mode="token"`, gebruik `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`).
- Wanneer `gateway.auth.mode="password"`, gebruik `gateway.auth.password` (of `OPENCLAW_GATEWAY_PASSWORD`).

## Een agent kiezen

Geen aangepaste headers nodig: codeer de agent-id in het OpenResponses `model` veld:

- `model: "openclaw:<agentId>"` (voorbeeld: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Of richt je op een specifieke OpenClaw-agent via een header:

- `x-openclaw-agent-id: <agentId>` (standaard: `main`)

Geavanceerd:

- `x-openclaw-session-key: <sessionKey>` om sessieroutering volledig te beheersen.

## Het endpoint inschakelen

Stel `gateway.http.endpoints.responses.enabled` in op `true`:

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

## Het endpoint uitschakelen

Stel `gateway.http.endpoints.responses.enabled` in op `false`:

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

## Sessievergedrag

Standaard is het endpoint **stateless per verzoek** (bij elke call wordt een nieuwe sessiesleutel gegenereerd).

Als het verzoek een OpenResponses `user` string bevat, leidt de Gateway hieruit een stabiele sessiesleutel af,
zodat herhaalde calls een agentsessie kunnen delen.

## Verzoekvorm (ondersteund)

Het verzoek volgt de OpenResponses API met item-gebaseerde invoer. Huidige ondersteuning:

- `input`: string of array van itemobjecten.
- `instructions`: samengevoegd in de systeemprompt.
- `tools`: client tool-definities (function tools).
- `tool_choice`: client tools filteren of vereisen.
- `stream`: schakelt SSE-streaming in.
- `max_output_tokens`: best-effort uitvoerlimiet (providerafhankelijk).
- `user`: stabiele sessieroutering.

Geaccepteerd maar **momenteel genegeerd**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (invoer)

### `message`

Rollen: `system`, `developer`, `user`, `assistant`.

- `system` en `developer` worden toegevoegd aan de systeemprompt.
- Het meest recente `user`- of `function_call_output`-item wordt het “huidige bericht”.
- Eerdere user/assistant-berichten worden opgenomen als geschiedenis voor context.

### `function_call_output` (turn-based tools)

Stuur toolresultaten terug naar het model:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` en `item_reference`

Geaccepteerd voor schemacompatibiliteit maar genegeerd bij het opbouwen van de prompt.

## Tools (client-side function tools)

Bied tools aan met `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Als de agent besluit een tool aan te roepen, retourneert het antwoord een `function_call` uitvoeritem.
Stuur vervolgens een vervolgaanvraag met `function_call_output` om de beurt voort te zetten.

## Afbeeldingen (`input_image`)

Ondersteunt base64- of URL-bronnen:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Toegestane MIME-types (huidig): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Maximale grootte (huidig): 10MB.

## Bestanden (`input_file`)

Ondersteunt base64- of URL-bronnen:

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

Toegestane MIME-types (huidig): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Maximale grootte (huidig): 5MB.

Huidig gedrag:

- Bestandsinhoud wordt gedecodeerd en toegevoegd aan de **systeemprompt**, niet aan het gebruikersbericht,
  zodat deze ephemeraal blijft (niet persistent in de sessiegeschiedenis).
- PDF’s worden geparseerd voor tekst. Als er weinig tekst wordt gevonden, worden de eerste pagina’s gerasteriseerd
  tot afbeeldingen en aan het model doorgegeven.

PDF-parsing gebruikt de Node-vriendelijke `pdfjs-dist` legacy build (zonder worker). De moderne
PDF.js-build verwacht browser-workers/DOM-globals en wordt daarom niet gebruikt in de Gateway.

Standaardwaarden voor URL-fetch:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Verzoeken zijn afgeschermd (DNS-resolutie, blokkering van private IP’s, redirect-limieten, time-outs).

## Bestands- en afbeeldingslimieten (config)

Standaarden kunnen worden aangepast onder `gateway.http.endpoints.responses`:

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

Standaarden wanneer weggelaten:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4.000.000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Streaming (SSE)

Stel `stream: true` in om Server-Sent Events (SSE) te ontvangen:

- `Content-Type: text/event-stream`
- Elke eventregel is `event: <type>` en `data: <json>`
- De stream eindigt met `data: [DONE]`

Eventtypen die momenteel worden uitgezonden:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (bij fout)

## Gebruik

`usage` wordt ingevuld wanneer de onderliggende provider tokentellingen rapporteert.

## Fouten

Fouten gebruiken een JSON-object zoals:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Veelvoorkomende gevallen:

- `401` ontbrekende/ongeldige authenticatie
- `400` ongeldig request body
- `405` verkeerde methode

## Voorbeelden

Niet-streaming:

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
