# Safety guard examples (template)

This folder contains optional, template-only shell guards:

- `safe_exec.example.sh`
- `web_input_guard.example.sh`
- `public_publish_guard.example.sh`
- `security_auto.example.sh`

They are intentionally non-invasive:
- no OpenClaw internals are changed,
- secrets and policy values are not hard-coded,
- examples are meant to be copied/adjusted in your local workspace.

Use with the security docs:
- `scripts/safety-guards/safe_exec.example.sh` for dangerous-action blocking + approval mode
- `.../web_input_guard.example.sh` for external text validation
- `.../public_publish_guard.example.sh` for redaction before publishing
- `.../security_auto.example.sh` to orchestrate mode-safe execution
