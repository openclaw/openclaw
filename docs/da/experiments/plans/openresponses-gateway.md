---
summary: "Plan: Tilføj OpenResponses /v1/responses-endpoint og udfas chat completions på en ren måde"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway-plan"
---

# OpenResponses Gateway-integrationsplan

## Context

OpenClaw Gateway eksponerer i øjeblikket et minimalt OpenAI-kompatibelt Chat Completions-endpoint på
`/v1/chat/completions` (se [OpenAI Chat Completions](/gateway/openai-http-api)).

Åbne svar er en åben inferens standard baseret på OpenAI svar API. Det er designet
til agentiske arbejdsgange og bruger item-baserede input plus semantiske streaming begivenheder. OpenResponses
spec definerer `/v1/responses`, ikke `/v1/chat/completions`.

## Goals

- Tilføj et `/v1/responses`-endpoint, der overholder OpenResponses-semantik.
- Bevar Chat Completions som et kompatibilitetslag, der er let at deaktivere og på sigt fjerne.
- Standardisér validering og parsing med isolerede, genanvendelige skemaer.

## Non-goals

- Fuld OpenResponses-funktionsparitet i første omgang (billeder, filer, hostede værktøjer).
- Udskiftning af intern agent-eksekveringslogik eller værktøjsorkestrering.
- Ændring af den eksisterende `/v1/chat/completions`-adfærd i den første fase.

## Research Summary

Kilder: OpenResponses OpenAPI, OpenResponses-specifikationssitet og Hugging Face-blogindlægget.

Uddragne hovedpunkter:

- `POST /v1/responses` accepterer `CreateResponseBody`-felter som `model`, `input` (streng eller
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` og
  `max_tool_calls`.
- `ItemParam` er en diskrimineret union af:
  - `message`-items med rollerne `system`, `developer`, `user`, `assistant`
  - `function_call` og `function_call_output`
  - `reasoning`
  - `item_reference`
- Succesfulde svar returnerer en `ResponseResource` med `object: "response"`, `status` og
  `output`-items.
- Streaming bruger semantiske events som:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Specifikationen kræver:
  - `Content-Type: text/event-stream`
  - `event:` skal matche JSON-`type`-feltet
  - terminal-event skal være den bogstavelige `[DONE]`
- Reasoning-items kan eksponere `content`, `encrypted_content` og `summary`.
- HF-eksempler inkluderer `OpenResponses-Version: latest` i requests (valgfri header).

## Proposed Architecture

- Tilføj `src/gateway/open-responses.schema.ts`, der kun indeholder Zod-skemaer (ingen gateway-imports).
- Tilføj `src/gateway/openresponses-http.ts` (eller `open-responses-http.ts`) for `/v1/responses`.
- Bevar `src/gateway/openai-http.ts` intakt som en legacy-kompatibilitetsadapter.
- Tilføj konfiguration `gateway.http.endpoints.responses.enabled` (standard `false`).
- Bevar `gateway.http.endpoints.chatCompletions.enabled` uafhængig; tillad at begge endpoints kan
  toggles separat.
- Udsend en opstartsadvarsel, når Chat Completions er aktiveret, for at signalere legacy-status.

## Deprecation Path for Chat Completions

- Oprethold stramme modulgrænser: ingen delte skematyper mellem responses og chat completions.
- Gør Chat Completions opt-in via konfiguration, så den kan deaktiveres uden kodeændringer.
- Opdatér dokumentationen til at mærke Chat Completions som legacy, når `/v1/responses` er stabil.
- Valgfrit fremtidigt trin: map Chat Completions-requests til Responses-handleren for en enklere
  fjernelsessti.

## Phase 1 Support Subset

- Acceptér `input` som streng eller `ItemParam[]` med beskedroller og `function_call_output`.
- Ekstrahér system- og developer-beskeder til `extraSystemPrompt`.
- Brug den seneste `user` eller `function_call_output` som den aktuelle besked for agent-kørsler.
- Afvis ikke-understøttede indholdsdele (billede/fil) med `invalid_request_error`.
- Returnér en enkelt assistant-besked med `output_text`-indhold.
- Returnér `usage` med nulstillede værdier, indtil token-accounting er koblet på.

## Validation Strategy (No SDK)

- Implementér Zod-skemaer for den understøttede delmængde af:
  - `CreateResponseBody`
  - `ItemParam` + unions for beskedindholdsdele
  - `ResponseResource`
  - Streaming-event-former brugt af gatewayen
- Bevar skemaer i et enkelt, isoleret modul for at undgå drift og muliggøre fremtidig codegen.

## Streaming Implementation (Phase 1)

- SSE-linjer med både `event:` og `data:`.
- Krævet sekvens (minimum levedygtig):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (gentages efter behov)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests and Verification Plan

- Tilføj e2e-dækning for `/v1/responses`:
  - Autentificering kræves
  - Non-stream-svarsform
  - Stream-event-rækkefølge og `[DONE]`
  - Session-routing med headers og `user`
- Bevar `src/gateway/openai-http.e2e.test.ts` uændret.
- Manuel: curl til `/v1/responses` med `stream: true` og verificér event-rækkefølge og terminal
  `[DONE]`.

## Doc Updates (Follow-up)

- Tilføj en ny docs-side for `/v1/responses`-brug og eksempler.
- Opdatér `/gateway/openai-http-api` med en legacy-note og henvisning til `/v1/responses`.
