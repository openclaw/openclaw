## Codex CLI model lane

Use model refs shaped like `codex-cli/<codex-model>` whenever QA should exercise Codex as a model backend.

Examples:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model codex-cli/<codex-model> \
  --alt-model codex-cli/<codex-model> \
  --scenario <scenario-id> \
  --output-dir .artifacts/qa-e2e/codex-<tag>
```

```bash
pnpm openclaw qa manual \
  --model codex-cli/<codex-model> \
  --message "Reply exactly: CODEX_OK"
```

- Treat the concrete Codex model name as user/config input; do not hardcode it in source, docs examples, or scenarios.
- Live QA preserves `CODEX_HOME` so Codex CLI auth/config works while keeping `HOME` and `OPENCLAW_HOME` sandboxed.
- Mock QA should scrub `CODEX_HOME`.
- If Codex returns fallback/auth text every turn, first check `CODEX_HOME`,
  relevant secret-backed auth, and gateway child logs before changing
  scenario assertions.
- For model comparison, include `codex-cli/<codex-model>` as another candidate in `qa character-eval`; the report should label it as an opaque model name.
