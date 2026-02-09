---
summary: "Exponera en OpenResponses-kompatibel /v1/responses HTTP-endpoint från Gateway"
read_when:
  - Integrera klienter som talar OpenResponses API
  - Du vill ha objektbaserade indata, klientverktygsanrop eller SSE-händelser
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaws Gateway kan exponera en OpenResponses-kompatibel `POST /v1/responses`-endpoint.

Denna slutpunkt är **inaktiverad som standard**. Aktivera det i konfigurationen först.

- `POST /v1/responses`
- Samma port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/v1/responses`

Under huven körs förfrågningar som en vanlig Gateway-agentkörning (samma kodväg som
`openclaw agent`), så routing/behörigheter/konfig matchar din Gateway.

## Autentisering

Använder Gateway auth konfiguration. Skicka en bärare token:

- `Authorization: Bearer <token>`

Noteringar:

- När `gateway.auth.mode="token"`, använd `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`).
- När `gateway.auth.mode="password"`, använd `gateway.auth.password` (eller `OPENCLAW_GATEWAY_PASSWORD`).

## Välja agent

Inga anpassade headers krävs: koda agent-id i OpenResponses-fältet `model`:

- `model: "openclaw:<agentId>"` (exempel: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Eller rikta in dig på en specifik OpenClaw-agent via header:

- `x-openclaw-agent-id: <agentId>` (standard: `main`)

Avancerat:

- `x-openclaw-session-key: <sessionKey>` för full kontroll över sessionsrouting.

## Aktivera endpointen

Sätt `gateway.http.endpoints.responses.enabled` till `true`:

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

## Inaktivera endpointen

Sätt `gateway.http.endpoints.responses.enabled` till `false`:

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

## Sessionsbeteende

Som standard är endpointen **tillståndslös per förfrågan** (en ny sessionsnyckel genereras vid varje anrop).

Om förfrågan inkluderar en OpenResponses-sträng `user` härleder Gateway en stabil sessionsnyckel
från den, så att upprepade anrop kan dela en agent-session.

## Förfrågans form (stöds)

Begäran följer OpenResponses API med objektbaserad indata. Nuvarande stöd:

- `input`: sträng eller array av objekt.
- `instructions`: slås samman i systemprompten.
- `tools`: klientverktygsdefinitioner (funktionsverktyg).
- `tool_choice`: filtrera eller kräva klientverktyg.
- `stream`: aktiverar SSE-streaming.
- `max_output_tokens`: bästa möjliga utdata-gräns (leverantörsberoende).
- `user`: stabil sessionsrouting.

Accepteras men **ignoreras för närvarande**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (indata)

### `message`

Roller: `system`, `developer`, `user`, `assistant`.

- `system` och `developer` läggs till i systemprompten.
- Den senaste `user`- eller `function_call_output`-posten blir ”aktuellt meddelande”.
- Tidigare user-/assistant-meddelanden inkluderas som historik för kontext.

### `function_call_output` (tur-baserade verktyg)

Skicka tillbaka verktygsresultat till modellen:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` och `item_reference`

Accepteras för schemakompatibilitet men ignoreras när prompten byggs.

## Verktyg (klientsidans funktionsverktyg)

Ge verktyg med `tools: [{ typ: "function", funktion: { namn, beskrivning?, parametrar? } }]`.

Om agenten bestämmer sig för att anropa ett verktyg returnerar svaret ett `function_call`-utdataobjekt.
Du skickar sedan en uppföljningsbegäran med `function_call_output` för att fortsätta svängen.

## Bilder (`input_image`)

Stöder base64- eller URL-källor:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Tillåtna MIME-typer (nuvarande): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Max storlek (nuvarande): 10MB.

## Filer (`input_file`)

Stöder base64- eller URL-källor:

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

Tillåtna MIME-typer (aktuella): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Maxstorlek (aktuellt): 5MB.

Nuvarande beteende:

- Filinnehåll avkodas och läggs till i **systemprompten**, inte i användarmeddelandet,
  så det förblir efemärt (sparas inte i sessionshistoriken).
- PDF-filer är tolkade för text. Om lite text hittas, är de första sidorna rasterized
  till bilder och skickas till modellen.

PDF parsning använder Node-vänliga `pdfjs-dist` äldre bygga (ingen arbetare). Den moderna
PDF.js bygga förväntar webbläsararbetare/DOM-globaler, så den används inte i Gateway.

Standardvärden för URL-hämtning:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Förfrågningar skyddas (DNS-upplösning, blockering av privata IP-adresser, begränsning av omdirigeringar, tidsgränser).

## Fil- och bildgränser (konfig)

Standardvärden kan justeras under `gateway.http.endpoints.responses`:

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

Standardvärden när de utelämnas:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Streaming (SSE)

Sätt `stream: true` för att ta emot Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Varje händelserad är `event: <type>` och `data: <json>`
- Strömmen avslutas med `data: [DONE]`

Händelsetyper som för närvarande skickas:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (vid fel)

## Användning

`usage` fylls i när den underliggande leverantören rapporterar tokenräkningar.

## Fel

Fel använder ett JSON-objekt som:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Vanliga fall:

- `401` saknad/ogiltig autentisering
- `400` ogiltig förfrågningskropp
- `405` fel metod

## Exempel

Icke-streaming:

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
