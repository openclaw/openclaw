---
summary: "Plan: OpenResponses /v1/responses-endpoint toevoegen en chatcompleties netjes uitfaseren"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway-plan"
---

# OpenResponses Gateway-integratieplan

## Context

OpenClaw Gateway stelt momenteel een minimale OpenAI-compatibele Chat Completions-endpoint beschikbaar op
`/v1/chat/completions` (zie [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses is een open inferentiestandaard gebaseerd op de OpenAI Responses API. Deze is ontworpen
voor agentische workflows en gebruikt item-gebaseerde invoer plus semantische streamingevents. De OpenResponses-
specificatie definieert `/v1/responses`, niet `/v1/chat/completions`.

## Doelen

- Een `/v1/responses`-endpoint toevoegen dat voldoet aan de OpenResponses-semantiek.
- Chat Completions behouden als compatibiliteitslaag die eenvoudig uit te schakelen is en uiteindelijk kan worden verwijderd.
- Validatie en parsing standaardiseren met geïsoleerde, herbruikbare schema’s.

## Niet-doelen

- Volledige OpenResponses-featurepariteit in de eerste fase (afbeeldingen, bestanden, gehoste tools).
- Het vervangen van interne agent-uitvoeringslogica of tool-orkestratie.
- Het wijzigen van het bestaande `/v1/chat/completions`-gedrag tijdens de eerste fase.

## Onderzoeksamenvatting

Bronnen: OpenResponses OpenAPI, OpenResponses-specificatiesite en de Hugging Face-blogpost.

Belangrijkste punten:

- `POST /v1/responses` accepteert `CreateResponseBody`-velden zoals `model`, `input` (string of
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` en
  `max_tool_calls`.
- `ItemParam` is een gediscrimineerde union van:
  - `message`-items met rollen `system`, `developer`, `user`, `assistant`
  - `function_call` en `function_call_output`
  - `reasoning`
  - `item_reference`
- Succesvolle responses retourneren een `ResponseResource` met `object: "response"`, `status` en
  `output`-items.
- Streaming gebruikt semantische events zoals:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- De specificatie vereist:
  - `Content-Type: text/event-stream`
  - `event:` moet overeenkomen met het JSON-veld `type`
  - het terminale event moet letterlijk `[DONE]` zijn
- Redeneeritems kunnen `content`, `encrypted_content` en `summary` blootleggen.
- HF-voorbeelden bevatten `OpenResponses-Version: latest` in requests (optionele header).

## Voorgestelde architectuur

- Voeg `src/gateway/open-responses.schema.ts` toe met uitsluitend Zod-schema’s (geen Gateway-imports).
- Voeg `src/gateway/openresponses-http.ts` (of `open-responses-http.ts`) toe voor `/v1/responses`.
- Houd `src/gateway/openai-http.ts` intact als legacy compatibiliteitsadapter.
- Voeg config `gateway.http.endpoints.responses.enabled` toe (standaard `false`).
- Houd `gateway.http.endpoints.chatCompletions.enabled` onafhankelijk; laat beide endpoints
  afzonderlijk kunnen worden omgeschakeld.
- Geef bij het opstarten een waarschuwing wanneer Chat Completions is ingeschakeld om de legacy-status te signaleren.

## Uitfaseringspad voor Chat Completions

- Handhaaf strikte modulegrenzen: geen gedeelde schematypen tussen responses en chat completions.
- Maak Chat Completions opt-in via config zodat het zonder codewijzigingen kan worden uitgeschakeld.
- Werk documentatie bij om Chat Completions als legacy te labelen zodra `/v1/responses` stabiel is.
- Optionele toekomstige stap: Chat Completions-requests mappen naar de Responses-handler voor een eenvoudiger
  verwijderingspad.

## Fase 1 ondersteunde subset

- Accepteer `input` als string of `ItemParam[]` met berichtrollen en `function_call_output`.
- Extraheer systeem- en ontwikkelaarsberichten naar `extraSystemPrompt`.
- Gebruik de meest recente `user` of `function_call_output` als het huidige bericht voor agent-runs.
- Wijs niet-ondersteunde contentonderdelen (afbeelding/bestand) af met `invalid_request_error`.
- Retourneer één assistentbericht met `output_text`-content.
- Retourneer `usage` met nulwaarden totdat tokenadministratie is aangesloten.

## Validatiestrategie (geen SDK)

- Implementeer Zod-schema’s voor de ondersteunde subset van:
  - `CreateResponseBody`
  - `ItemParam` + unions voor berichtcontentonderdelen
  - `ResponseResource`
  - Streaming-eventvormen die door de Gateway worden gebruikt
- Houd schema’s in één geïsoleerde module om drift te voorkomen en toekomstige codegeneratie mogelijk te maken.

## Streaming-implementatie (fase 1)

- SSE-regels met zowel `event:` als `data:`.
- Vereiste volgorde (minimaal levensvatbaar):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (herhaal indien nodig)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests en verificatieplan

- Voeg e2e-dekking toe voor `/v1/responses`:
  - Authenticatie vereist
  - Vorm van non-stream-response
  - Volgorde van streamevents en `[DONE]`
  - Sessierouting met headers en `user`
- Houd `src/gateway/openai-http.e2e.test.ts` ongewijzigd.
- Handmatig: curl naar `/v1/responses` met `stream: true` en verifieer eventvolgorde en het terminale
  `[DONE]`.

## Documentatie-updates (follow-up)

- Voeg een nieuwe documentatiepagina toe voor `/v1/responses`-gebruik en voorbeelden.
- Werk `/gateway/openai-http-api` bij met een legacy-opmerking en een verwijzing naar `/v1/responses`.
