---
summary: "ACP thread-bound follow-up orchestration, parent assistant should rewrite shorthand follow-ups before sending to child session"
title: "ACP follow-up orchestration"
read_when:
  - ACP session is thread-bound and you need to handle user follow-ups
---

# ACP follow-up orchestration

## Rule

Thread-bound ACP session continuity does not imply verbatim forwarding.

When an ACP session is bound to a thread, the parent assistant should remain the default interpreter for user follow-ups. The child session stays alive for continuity, but shorthand follow-ups should be rewritten into explicit child instructions unless the user clearly requests exact relay.

## Default behavior

For a follow-up like:

- "do that"
- "continue with what you suggested"
- "ok implement phase 2"
- "have it continue with what you suggested"

The parent assistant should:

1. resolve the reference from parent-thread context
2. synthesize a self-contained task prompt
3. send the rewritten task to the bound ACP child session

## Verbatim relay

Exact forwarding should happen only when the user explicitly asks for it, for example:

- "send this exact prompt"
- "forward this verbatim"
- "send this block verbatim"

## Why

Users speak to the parent orchestrator in shorthand. If raw text is passed through directly, the child harness receives low-context prompts and overall ACP orchestration quality degrades.
