---
summary: "Plano: Idagdag ang OpenResponses /v1/responses endpoint at i-deprecate nang maayos ang chat completions"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plano ng OpenResponses Gateway"
---

# Plano ng Integrasyon ng OpenResponses Gateway

## Konteksto

Ang OpenClaw Gateway ay kasalukuyang naglalantad ng isang minimal na OpenAI-compatible Chat Completions endpoint sa
`/v1/chat/completions` (tingnan ang [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses is an open inference standard based on the OpenAI Responses API. It is designed
for agentic workflows and uses item-based inputs plus semantic streaming events. The OpenResponses
spec defines `/v1/responses`, not `/v1/chat/completions`.

## Mga Layunin

- Magdagdag ng isang `/v1/responses` endpoint na sumusunod sa OpenResponses semantics.
- Panatilihin ang Chat Completions bilang isang compatibility layer na madaling i-disable at kalaunan ay alisin.
- I-standardize ang validation at parsing gamit ang hiwalay at reusable na mga schema.

## Mga Hindi Layunin

- Buong OpenResponses feature parity sa unang pasada (mga image, file, hosted tools).
- Pagpapalit ng internal agent execution logic o tool orchestration.
- Pagbabago ng umiiral na `/v1/chat/completions` na behavior sa unang yugto.

## Buod ng Pananaliksik

Mga pinagmulan: OpenResponses OpenAPI, OpenResponses specification site, at ang blog post ng Hugging Face.

Mga pangunahing puntong nakuha:

- Tumatanggap ang `POST /v1/responses` ng mga `CreateResponseBody` field tulad ng `model`, `input` (string o
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, at
  `max_tool_calls`.
- Ang `ItemParam` ay isang discriminated union ng:
  - mga `message` item na may mga role na `system`, `developer`, `user`, `assistant`
  - `function_call` at `function_call_output`
  - `reasoning`
  - `item_reference`
- Ang mga matagumpay na response ay nagbabalik ng isang `ResponseResource` na may `object: "response"`, `status`, at
  mga `output` item.
- Ang streaming ay gumagamit ng mga semantic event tulad ng:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Kinakailangan ng spec ang:
  - `Content-Type: text/event-stream`
  - Ang `event:` ay dapat tumugma sa JSON `type` field
  - Ang terminal event ay dapat literal na `[DONE]`
- Ang mga reasoning item ay maaaring maglantad ng `content`, `encrypted_content`, at `summary`.
- Kasama sa mga HF example ang `OpenResponses-Version: latest` sa mga request (opsyonal na header).

## Iminungkahing Arkitektura

- Magdagdag ng `src/gateway/open-responses.schema.ts` na naglalaman lamang ng mga Zod schema (walang gateway imports).
- Magdagdag ng `src/gateway/openresponses-http.ts` (o `open-responses-http.ts`) para sa `/v1/responses`.
- Panatilihing buo ang `src/gateway/openai-http.ts` bilang isang legacy compatibility adapter.
- Magdagdag ng config `gateway.http.endpoints.responses.enabled` (default `false`).
- Panatilihing independent ang `gateway.http.endpoints.chatCompletions.enabled`; pahintulutan na ang parehong endpoint ay
  ma-toggle nang hiwalay.
- Maglabas ng startup warning kapag naka-enable ang Chat Completions upang ipahiwatig ang legacy status.

## Landas ng Deprecation para sa Chat Completions

- Panatilihin ang mahigpit na hangganan ng mga module: walang shared schema type sa pagitan ng responses at chat completions.
- Gawing opt-in sa pamamagitan ng config ang Chat Completions upang ma-disable ito nang walang pagbabago sa code.
- I-update ang docs upang lagyan ng label ang Chat Completions bilang legacy kapag stable na ang `/v1/responses`.
- Opsyonal na hakbang sa hinaharap: i-map ang mga Chat Completions request sa Responses handler para sa mas simpleng
  landas ng pag-alis.

## Phase 1 na Support Subset

- Tanggapin ang `input` bilang string o `ItemParam[]` na may mga message role at `function_call_output`.
- I-extract ang system at developer message papunta sa `extraSystemPrompt`.
- Gamitin ang pinakahuling `user` o `function_call_output` bilang kasalukuyang mensahe para sa mga agent run.
- I-reject ang mga hindi suportadong content part (image/file) gamit ang `invalid_request_error`.
- Magbalik ng isang assistant message na may `output_text` na content.
- Magbalik ng `usage` na may zeroed na mga value hanggang maikabit ang token accounting.

## Estratehiya sa Validation (Walang SDK)

- Magpatupad ng mga Zod schema para sa suportadong subset ng:
  - `CreateResponseBody`
  - `ItemParam` + mga union ng message content part
  - `ResponseResource`
  - Mga shape ng streaming event na ginagamit ng Gateway
- Panatilihin ang mga schema sa isang solong, hiwalay na module upang maiwasan ang drift at pahintulutan ang future codegen.

## Implementasyon ng Streaming (Phase 1)

- Mga SSE line na may parehong `event:` at `data:`.
- Kinakailangang sequence (minimum viable):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (ulitin kung kinakailangan)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Mga Test at Plano sa Pag-verify

- Magdagdag ng e2e coverage para sa `/v1/responses`:
  - Kinakailangan ang auth
  - Non-stream na response shape
  - Pagkakasunod-sunod ng stream event at `[DONE]`
  - Session routing gamit ang mga header at `user`
- Panatilihing hindi nagbabago ang `src/gateway/openai-http.e2e.test.ts`.
- Manual: curl papunta sa `/v1/responses` gamit ang `stream: true` at i-verify ang event ordering at ang terminal
  `[DONE]`.

## Mga Update sa Docs (Follow-up)

- Magdagdag ng bagong docs page para sa paggamit at mga halimbawa ng `/v1/responses`.
- I-update ang `/gateway/openai-http-api` na may legacy note at pointer papunta sa `/v1/responses`.
