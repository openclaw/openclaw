# GitHub Copilot Test Ownership

- Assert embedding adapter metadata through plugin registration in `index.test.ts`.
  Memory auto-selection no longer invokes the retired fallback classifier; do not
  restore private classifier tests or adapter callbacks without a runtime caller.
- Keep device-code presentation and credential-result assertions in the same
  provider-auth contract flow. Non-TTY, denial, and expiry remain separate contracts.
- Test embedding discovery with one eligible, non-preferred model per metadata
  shape and an ineligible model first. A preferred winner can hide filtering bugs.
- Keep discovery error redaction in the real-transport case with log redaction
  disabled. Embedding POST errors have a separate transport boundary.
- Use actual plugin replay policy for provider claims. Explicit core policy tests
  must name the injected policy, not impersonate a different Copilot transport.
- Keep following content after reasoning replay IDs when testing length limits;
  trailing-reasoning cleanup otherwise masks the guard. Overlong tool-ID tests
  must exercise the logical call ID, not only an item ID omitted by default.
- At shared consumers, assert image payload values and zero side effects after
  auth preparation fails. Timer shutdown tests must advance past the scheduled
  refresh, not merely past run completion.
