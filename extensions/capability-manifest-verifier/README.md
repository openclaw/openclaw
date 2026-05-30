# Capability Manifest Verifier

Bundled OpenClaw plugin that registers a trusted tool policy for broker-issued
capability manifests. When enabled, each tool call is checked against a signed
HS256 JWT before ordinary `before_tool_call` hooks run.

The plugin intentionally does not store secrets in config. Operators provide the
manifest token through `OPENCLAW_CAPABILITY_MANIFEST_JWT` or `manifestPath`, and
the HS256 secret through `OPENCLAW_CAPABILITY_MANIFEST_SECRET`.

Supported grant decisions are `allowed`, `requires_approval`, and `denied`.
Unknown tools fail closed by default unless `defaultDecision` is explicitly set
to `allow`.
