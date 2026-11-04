## Unreleased

### Fixes

- macOS: the packaged Codex code-mode host keeps JIT entitlements, so Codex tool calls no longer die when V8 reserves code memory. (#192851) Thanks @h6y3.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
