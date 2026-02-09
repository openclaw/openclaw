---
summary: "Plan: Hinzufügen des OpenResponses-Endpunkts /v1/responses und saubere Deprecation von Chat Completions"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses-Gateway-Plan"
---

# OpenResponses-Gateway-Integrationsplan

## Kontext

Das OpenClaw Gateway stellt derzeit einen minimalen OpenAI-kompatiblen Chat-Completions-Endpunkt unter
`/v1/chat/completions` bereit (siehe [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses ist ein offener Inferenzstandard, der auf der OpenAI Responses API basiert. Er ist für agentische Workflows konzipiert und verwendet item-basierte Eingaben sowie semantische Streaming-Events. Die OpenResponses-Spezifikation definiert `/v1/responses`, nicht `/v1/chat/completions`.

## Ziele

- Hinzufügen eines `/v1/responses`-Endpunkts, der den OpenResponses-Semantiken entspricht.
- Beibehaltung von Chat Completions als Kompatibilitätsschicht, die einfach zu deaktivieren und schließlich zu entfernen ist.
- Standardisierung von Validierung und Parsing mit isolierten, wiederverwendbaren Schemas.

## Nicht-Ziele

- Vollständige OpenResponses-Funktionsparität im ersten Durchlauf (Bilder, Dateien, gehostete Werkzeuge).
- Ersetzung der internen Agent-Ausführungslogik oder der Tool-Orchestrierung.
- Änderung des bestehenden `/v1/chat/completions`-Verhaltens in der ersten Phase.

## Forschungszusammenfassung

Quellen: OpenResponses OpenAPI, OpenResponses-Spezifikationsseite und der Hugging-Face-Blogbeitrag.

Schlüsselpunkte extrahiert:

- `POST /v1/responses` akzeptiert `CreateResponseBody`-Felder wie `model`, `input` (String oder
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` und
  `max_tool_calls`.
- `ItemParam` ist eine diskriminierte Union aus:
  - `message`-Items mit Rollen `system`, `developer`, `user`, `assistant`
  - `function_call` und `function_call_output`
  - `reasoning`
  - `item_reference`
- Erfolgreiche Antworten liefern ein `ResponseResource` mit `object: "response"`, `status` und
  `output`-Items.
- Streaming verwendet semantische Events wie:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Die Spezifikation verlangt:
  - `Content-Type: text/event-stream`
  - `event:` muss dem JSON-Feld `type` entsprechen
  - Das terminale Event muss das Literal `[DONE]` sein
- Reasoning-Items können `content`, `encrypted_content` und `summary` offenlegen.
- HF-Beispiele enthalten `OpenResponses-Version: latest` in Anfragen (optional Header).

## Vorgeschlagene Architektur

- Hinzufügen von `src/gateway/open-responses.schema.ts`, das ausschließlich Zod-Schemas enthält (keine Gateway-Imports).
- Hinzufügen von `src/gateway/openresponses-http.ts` (oder `open-responses-http.ts`) für `/v1/responses`.
- Beibehaltung von `src/gateway/openai-http.ts` als Legacy-Kompatibilitätsadapter.
- Hinzufügen der Konfiguration `gateway.http.endpoints.responses.enabled` (Standard `false`).
- Beibehaltung von `gateway.http.endpoints.chatCompletions.enabled` als unabhängig; beide Endpunkte können
  separat umgeschaltet werden.
- Ausgabe einer Startwarnung, wenn Chat Completions aktiviert ist, um den Legacy-Status zu signalisieren.

## Deprecation-Pfad für Chat Completions

- Strikte Modulgrenzen einhalten: keine gemeinsam genutzten Schema-Typen zwischen Responses und Chat Completions.
- Chat Completions per Konfiguration opt-in machen, sodass es ohne Codeänderungen deaktiviert werden kann.
- Dokumentation aktualisieren, um Chat Completions als Legacy zu kennzeichnen, sobald `/v1/responses` stabil ist.
- Optionaler zukünftiger Schritt: Zuordnung von Chat-Completions-Anfragen zum Responses-Handler für einen einfacheren
  Entfernungspfad.

## Phase-1-Unterstützungsumfang

- Akzeptieren von `input` als String oder `ItemParam[]` mit Nachrichtenrollen und `function_call_output`.
- Extrahieren von System- und Entwicklernachrichten in `extraSystemPrompt`.
- Verwenden der aktuellsten `user` oder `function_call_output` als aktuelle Nachricht für Agent-Ausführungen.
- Ablehnen nicht unterstützter Inhaltsbestandteile (Bild/Datei) mit `invalid_request_error`.
- Rückgabe einer einzelnen Assistant-Nachricht mit `output_text`-Inhalt.
- Rückgabe von `usage` mit genullten Werten, bis die Token-Abrechnung angebunden ist.

## Validierungsstrategie (kein SDK)

- Implementierung von Zod-Schemas für den unterstützten Teil von:
  - `CreateResponseBody`
  - `ItemParam` + Unions der Nachrichteninhaltsbestandteile
  - `ResponseResource`
  - Streaming-Event-Formen, die vom Gateway verwendet werden
- Schemas in einem einzelnen, isolierten Modul halten, um Drift zu vermeiden und zukünftige Codegenerierung zu ermöglichen.

## Streaming-Implementierung (Phase 1)

- SSE-Zeilen mit sowohl `event:` als auch `data:`.
- Erforderliche Sequenz (minimal funktionsfähig):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (bei Bedarf wiederholen)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests und Verifizierungsplan

- Hinzufügen von E2E-Abdeckung für `/v1/responses`:
  - Authentifizierung erforderlich
  - Nicht-Streaming-Antwortform
  - Reihenfolge der Stream-Events und `[DONE]`
  - Sitzungsrouting mit Headern und `user`
- Beibehaltung von `src/gateway/openai-http.e2e.test.ts` unverändert.
- Manuell: curl an `/v1/responses` mit `stream: true` und Verifizierung der Event-Reihenfolge sowie des terminalen
  `[DONE]`.

## Dokumentationsaktualisierungen (Follow-up)

- Hinzufügen einer neuen Dokumentationsseite für die Nutzung und Beispiele von `/v1/responses`.
- Aktualisierung von `/gateway/openai-http-api` mit einem Legacy-Hinweis und Verweis auf `/v1/responses`.
