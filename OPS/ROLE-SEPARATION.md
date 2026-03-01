# OpenClaw Two-Node Role Separation

## Node roles

- Mac node: development and portable operations node.
  - Primary use: local development, testing, and controlled rollouts.
  - Optional fallback: local LLM provider(s), such as Ollama, when cloud access is unavailable.
- Windows 11 Docker node: always-on production-like node.
  - Primary use: stable continuous runtime.
  - Provider policy: cloud OpenAI only (no local LLM runtime on this node).

## Source of truth

- Single source of truth for code, compose, and docs: this repository.
- Mac is the authoring node; Windows consumes the same repo state.

## Deployment model

- One `docker-compose.yml` is shared by both nodes.
- Environment differences are handled only through env files:
  - Mac: `.env.mac`
  - Windows: `.env.win`
- Do not fork compose per host unless there is a hard technical blocker.

## Configuration boundary

- Keep host-specific values in env files only (ports, bind paths, tokens, provider keys).
- Keep application logic and service definitions host-agnostic in `docker-compose.yml`.
