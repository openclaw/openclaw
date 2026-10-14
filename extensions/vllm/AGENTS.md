# vLLM Tests

- Keep discovery defaults real. Mock model discovery, not provider constants or
  provider construction. The shared discovery contract also covers SGLang;
  preserve its configured transport and manual-discovery cases.
- Stream bypass cases must prove the underlying stream ran with an unchanged
  payload. Use the runtime's wrapped-or-base selection when no wrapper is needed.
- Keep registered-hook coverage separate from direct thinking-policy tests.
  A shared helper test does not prove that the plugin registers its override.
- Keep Qwen migration source scopes independent. Default params must not create
  the model row that an inherited-agent assertion claims to exercise.
- Configured inline model resolution is not fallback resolution. Preserve both
  stale and empty registry inputs without claiming they exercise different paths.
