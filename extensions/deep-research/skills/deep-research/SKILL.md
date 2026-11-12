---
name: deep-research
description: Explicitly request bounded, source-backed Deep Research using this conversation’s sources and budget.
user-invocable: true
disable-model-invocation: true
---

# Deep Research

Use the existing `deep_research` tool and its retained job owner. This is a
user-selected workflow, not a separate research engine or permission grant.
Selecting it does not mean a job was accepted or started. Do not invoke it just
because an ordinary question or quoted material mentions research.

## Prepare the request

- Use the question and constraints from the selected request and current chat.
  Reuse supplied documents, explicit URLs, source restrictions, requested date,
  output focus, and budget; do not ask the user to paste them again. Read relevant
  attachments through the available, authorized document tools when needed.
  Do not imply that an unread attachment was included.
- Default to `engine: "portable"`, the conversation’s configured model and normal
  credentials. Do not select a different model, provider, profile, or managed
  engine to work around a refusal. Use Google managed research only when
  explicitly requested and configured; it cannot enforce portable source or
  budget controls.
- Put supplied text in `sources.documents` with its title and text. For
  document-only/no-web requests, set `sources.web: false` and omit URLs unless
  their fetch was requested. Supplying documents disables public search by
  default; mixed web research needs the user’s explicit request. Never send
  private document contents as web-search queries.
- Preserve supported `budget` fields: `modelCalls`, `searches`, `fetches`,
  `durationMs`, and `parallelism`. Without overrides, portable defaults are
  8 model calls, 6 searches, 12 fetches, 2 parallel fetches, and 180 seconds.
  These are call/deadline limits, not a guaranteed token or dollar cap. Do not
  silently raise a limit. If a requested hard spending cap or source constraint
  cannot be enforced, explain that limitation before starting. Ask only about
  consequential missing choices, not constraints already available in chat.

## Submit through the existing tool

1. Resolve `deep_research` from the tools available in this turn. In Code Mode,
   use the catalog to find its effective callable name and read its input
   contract. Do not use a shell, direct RPC, alternate account, or new tool as
   a substitute when the plugin or tool policy blocks access.
2. Choose one stable `idempotencyKey` for this request and call `action: "start"`
   with the prepared `request`. Retain the exact key, request, and returned
   `jobId` in the conversation’s tool evidence.
3. Report only the returned state. A selected skill or planned tool call is not
   a receipt. A returned queued job is accepted, not necessarily executing; a
   running job is not complete. Do not say “started” without a returned job.
4. If the start response is uncertain, reuse the same key and exact request to
   reconcile it; never mint a replacement key as an automatic retry. An
   indeterminate submission needs inspection, not another purchase. Do not
   change the request under an existing key.

## Follow the retained job

- Use `status` and `result` with the returned `jobId`. The service owns recovery
  and due wakes; do not create a parallel polling loop, scheduler, or background
  research agent. Read the retained result before presenting the report.
- Honor cancellation with `cancel` on that same job. Report cancellation as
  confirmed only when the owner returns a terminal cancellation state; a local
  abort or pending cancellation is not confirmation. Resume only when authorized
  and supported by the returned state.
- Keep all operations in the originating conversation and its current authority.
  A job handle is not permission to move work to another session, survive a
  reset/replacement, or bypass a revoked source or tool policy.
- Present source-backed findings, citations, actual route, and explicit gaps.
  Distinguish supplied/fetched text from provider-attributed citations, and
  quote matching from the fallible model support check. Preserve partial,
  paused, indeterminate, failed, and cancelled outcomes honestly; never turn
  missing evidence or an exhausted budget into a claim of completion.
