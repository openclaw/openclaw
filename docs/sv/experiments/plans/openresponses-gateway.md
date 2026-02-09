---
summary: "Plan: Lägg till OpenResponses-/v1/responses-slutpunkt och fasa ut chat completions på ett rent sätt"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plan för OpenResponses Gateway"
---

# Integrationsplan för OpenResponses Gateway

## Kontext

OpenClaw Gateway exponerar för närvarande en minimal OpenAI-kompatibel Chat Completions-slutpunkt på
`/v1/chat/completions` (se [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses är en öppen inferensstandard baserad på OpenAI Responses API. Den är utformad
för agentic arbetsflöden och använder objektbaserade ingångar plus semantiska strömningshändelser. OpenResponses
spec definierar `/v1/responses`, inte `/v1/chat/complettions`.

## Mål

- Lägg till en `/v1/responses`-slutpunkt som följer OpenResponses-semantik.
- Behåll Chat Completions som ett kompatibilitetslager som är enkelt att inaktivera och så småningom ta bort.
- Standardisera validering och parsning med isolerade, återanvändbara scheman.

## Icke-mål

- Full funktionsparitet med OpenResponses i första etappen (bilder, filer, hostade verktyg).
- Ersätta intern agentexekveringslogik eller verktygsorkestrering.
- Ändra befintligt `/v1/chat/completions`-beteende under den första fasen.

## Forskningssammanfattning

Källor: OpenResponses OpenAPI, OpenResponses specifikationssajt samt blogginlägget från Hugging Face.

Viktiga punkter:

- `POST /v1/responses` accepterar `CreateResponseBody`-fält som `model`, `input` (sträng eller
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` och
  `max_tool_calls`.
- `ItemParam` är en diskriminerad union av:
  - `message`-objekt med rollerna `system`, `developer`, `user`, `assistant`
  - `function_call` och `function_call_output`
  - `reasoning`
  - `item_reference`
- Lyckade svar returnerar ett `ResponseResource` med `object: "response"`, `status` och
  `output`-objekt.
- Strömning använder semantiska händelser såsom:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Specifikationen kräver:
  - `Content-Type: text/event-stream`
  - `event:` måste matcha JSON-fältet `type`
  - den terminala händelsen måste vara den bokstavliga `[DONE]`
- Resonemangsobjekt kan exponera `content`, `encrypted_content` och `summary`.
- HF-exempel inkluderar `OpenResponses-Version: latest` i förfrågningar (valfri header).

## Föreslagen arkitektur

- Lägg till `src/gateway/open-responses.schema.ts` som endast innehåller Zod-scheman (inga gateway-importer).
- Lägg till `src/gateway/openresponses-http.ts` (eller `open-responses-http.ts`) för `/v1/responses`.
- Behåll `src/gateway/openai-http.ts` intakt som en äldre kompatibilitetsadapter.
- Lägg till konfig `gateway.http.endpoints.responses.enabled` (standard `false`).
- Behåll `gateway.http.endpoints.chatCompletions.enabled` oberoende; tillåt att båda slutpunkterna
  växlas separat.
- Skicka en startvarning när Chat Completions är aktiverat för att signalera äldre status.

## Utfasningsväg för Chat Completions

- Upprätthåll strikta modulgränser: inga delade schematyper mellan responses och chat completions.
- Gör Chat Completions opt-in via konfig så att det kan inaktiveras utan kodändringar.
- Uppdatera dokumentationen för att märka Chat Completions som äldre när `/v1/responses` är stabil.
- Valfritt framtida steg: mappa Chat Completions-förfrågningar till Responses-hanteraren för en enklare
  borttagningsväg.

## Fas 1: Stödd delmängd

- Acceptera `input` som sträng eller `ItemParam[]` med meddelanderoller och `function_call_output`.
- Extrahera system- och utvecklarmeddelanden till `extraSystemPrompt`.
- Använd den senaste `user` eller `function_call_output` som aktuellt meddelande för agentkörningar.
- Avvisa innehållsdelar som inte stöds (bild/fil) med `invalid_request_error`.
- Returnera ett enda assistentmeddelande med `output_text`-innehåll.
- Returnera `usage` med nollade värden tills tokenredovisning är inkopplad.

## Valideringsstrategi (ingen SDK)

- Implementera Zod-scheman för den stödda delmängden av:
  - `CreateResponseBody`
  - `ItemParam` + unioner för meddelandets innehållsdelar
  - `ResponseResource`
  - Former för strömningshändelser som används av gatewayn
- Håll scheman i en enda, isolerad modul för att undvika avvikelser och möjliggöra framtida kodgenerering.

## Strömningsimplementering (fas 1)

- SSE-rader med både `event:` och `data:`.
- Krävd sekvens (minimalt gångbar):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (upprepa vid behov)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tester och verifieringsplan

- Lägg till e2e-täckning för `/v1/responses`:
  - Autentisering krävs
  - Icke-strömmande svarsform
  - Ordning på strömningshändelser och `[DONE]`
  - Sessionsroutning med headers och `user`
- Behåll `src/gateway/openai-http.e2e.test.ts` oförändrad.
- Manuellt: curl till `/v1/responses` med `stream: true` och verifiera händelseordning och terminal
  `[DONE]`.

## Dokumentuppdateringar (uppföljning)

- Lägg till en ny dokumentsida för användning och exempel för `/v1/responses`.
- Uppdatera `/gateway/openai-http-api` med en notering om äldre status och en hänvisning till `/v1/responses`.
