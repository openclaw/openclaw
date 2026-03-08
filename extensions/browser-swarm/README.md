# Browser Swarm (MVP)

Distributed browser-orchestration primitives for OpenClaw.

MVP scope:

- Worker registry + health
- Task scheduling + lease model
- Session assignment and rotation
- Domain concurrency/rate limiting
- Captcha adapter interface (stub)

This package is backend-agnostic and currently uses in-memory state.
