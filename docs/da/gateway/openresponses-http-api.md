---
summary: "Eksponér et OpenResponses-kompatibelt /v1/responses HTTP-endpoint fra Gateway"
read_when:
  - Integrering af klienter, der taler OpenResponses API
  - Du ønsker item-baserede input, klientværktøjskald eller SSE-events
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaws Gateway kan betjene et OpenResponses-kompatibelt `POST /v1/responses` endpoint.

Dette endepunkt er **deaktiveret som standard**. Aktiver det i config først.

- `POST /v1/responses`
- Samme port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/v1/responses`

Under motorhjelmen udføres forespørgsler som et normalt Gateway-agentkørsel (samme kodevej som
`openclaw agent`), så routing/tilladelser/konfiguration matcher din Gateway.

## Autentificering

Bruger Gateway auth konfiguration. Send et bærer-token:

- `Authorization: Bearer <token>`

Noter:

- Når `gateway.auth.mode="token"`, brug `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`).
- Når `gateway.auth.mode="password"`, brug `gateway.auth.password` (eller `OPENCLAW_GATEWAY_PASSWORD`).

## Valg af agent

Ingen brugerdefinerede headere kræves: indkod agent-id’et i OpenResponses `model`-feltet:

- `model: "openclaw:<agentId>"` (eksempel: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Eller målret en specifik OpenClaw-agent via header:

- `x-openclaw-agent-id: <agentId>` (standard: `main`)

Avanceret:

- `x-openclaw-session-key: <sessionKey>` for fuld kontrol over session-routing.

## Aktivering af endpointet

Sæt `gateway.http.endpoints.responses.enabled` til `true`:

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

## Deaktivering af endpointet

Sæt `gateway.http.endpoints.responses.enabled` til `false`:

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

## Session-adfærd

Som standard er endpointet **tilstandsløst pr. forespørgsel** (der genereres en ny sessionsnøgle ved hvert kald).

Hvis forespørgslen indeholder en OpenResponses `user`-streng, udleder Gateway en stabil sessionsnøgle
fra den, så gentagne kald kan dele en agentsession.

## Forespørgselsformat (understøttet)

Anmodningen følger OpenResponses API med elementbaseret input. Nuværende support:

- `input`: streng eller array af item-objekter.
- `instructions`: flettes ind i systemprompten.
- `tools`: klientværktøjsdefinitioner (funktionsværktøjer).
- `tool_choice`: filtrér eller kræv klientværktøjer.
- `stream`: aktiverer SSE-streaming.
- `max_output_tokens`: best-effort outputgrænse (udbyderafhængig).
- `user`: stabil session-routing.

Accepteret men **aktuelt ignoreret**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (input)

### `message`

Roller: `system`, `developer`, `user`, `assistant`.

- `system` og `developer` tilføjes til systemprompten.
- Det seneste `user`- eller `function_call_output`-item bliver den “aktuelle besked”.
- Tidligere bruger-/assistantbeskeder medtages som historik for kontekst.

### `function_call_output` (tur-baserede værktøjer)

Send værktøjsresultater tilbage til modellen:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` og `item_reference`

Accepteres for skemakompatibilitet, men ignoreres ved opbygning af prompten.

## Værktøjer (klientside funktionsværktøjer)

Giv værktøjer med `værktøjer: [{ type: "funktion", funktion: { navn, beskrivelse?, parametre? } }]`.

Hvis agenten beslutter at kalde et værktøj, returnerer svaret et `function_call` output element.
Du sender derefter en opfølgningsanmodning med `function_call_output` for at fortsætte turen.

## Billeder (`input_image`)

Understøtter base64- eller URL-kilder:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Tilladte MIME-typer (nuværende): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Maks. størrelse (nuværende): 10MB.

## Filer (`input_file`)

Understøtter base64- eller URL-kilder:

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

Tilladte MIME-typer (aktuelt): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Maks. størrelse (nuværende): 5MB.

Nuværende adfærd:

- Filindhold dekodes og tilføjes til **systemprompten**, ikke brugermeddelelsen,
  så det forbliver efemerisk (ikke gemt i sessionshistorikken).
- PDF-filer fortolkes for tekst. Hvis der er fundet lidt tekst, bliver de første sider rasteriseret
  til billeder og sendt til modellen.

PDF-parsing bruger Node-venlige `pdfjs-dist` arv build (ingen arbejder). Den moderne
PDF.js build forventer browser workers/DOM globals, så det ikke bruges i Gateway.

Standardindstillinger for URL-hentning:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Forespørgsler er beskyttet (DNS-opslag, blokering af private IP’er, redirect-grænser, timeouts).

## Fil- og billedgrænser (konfiguration)

Standarder kan justeres under `gateway.http.endpoints.responses`:

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

Standarder når udeladt:

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

Sæt `stream: true` for at modtage Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Hver eventlinje er `event: <type>` og `data: <json>`
- Streamen slutter med `data: [DONE]`

Eventtyper, der aktuelt udsendes:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (ved fejl)

## Forbrug

`usage` udfyldes, når den underliggende udbyder rapporterer token-tællinger.

## Fejl

Fejl bruger et JSON-objekt som:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Almindelige tilfælde:

- `401` manglende/ugyldig autentificering
- `400` ugyldig forespørgselskrop
- `405` forkert metode

## Eksempler

Ikke-streaming:

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
