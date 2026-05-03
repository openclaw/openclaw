---
summary: "Avoid wasting automation cycles on gated preview models that require approval before platform setup"
read_when:
  - Choosing models for scheduled jobs
  - Evaluating preview API access claims
  - Configuring provider fallbacks
title: "Gated Model Access"
---

# Gated Model Access

Do not treat gated preview models as normal model IDs.

The Claude Mythos access guidance is a useful rule for all provider automation:
approval comes before platform setup. If a model is invitation-only, a cloud
account, region flag, or console toggle is not enough.

## Policy

- Pin production and cron jobs to currently verified public or account-enabled models.
- Track gated models in a watchlist, not in live fallback chains.
- Add a model only after a direct smoke test succeeds in the same runtime profile.
- Keep fallback chains short and ordered by known reliability, not novelty.
- Use public Claude, OpenAI, OpenRouter, Abacus, or local models that are already enabled for the account.

## Review Checklist

Before adding a model to OpenClaw config or cron:

- The model is publicly available or explicitly enabled for this account.
- The provider auth path is loaded by the LaunchAgent or sandbox runtime.
- A one-turn smoke test has passed.
- The cost and timeout profile are acceptable for scheduled use.
- The model name is fully qualified, not a shorthand such as `gpt`.
