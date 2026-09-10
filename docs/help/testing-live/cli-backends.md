---
summary: "Live CLI backend smoke (Claude, Gemini, other local CLIs) and the APNs HTTP/2 proxy reachability check"
title: "CLI backend and APNs lanes"
read_when:
  - You are validating the gateway against a local CLI backend
  - You are checking APNs reachability through an HTTP CONNECT proxy
---

## Live: CLI backend smoke (Claude, Gemini, or other local CLIs)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Goal: validate the Gateway + agent pipeline using a local CLI backend, without touching your default config.
- Backend-specific smoke defaults live with the owning plugin's `cli-backend.ts` definition.
- Enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Defaults:
  - Default provider/model: `claude-cli/claude-sonnet-4-6`
  - Command/args/image behavior come from the owning CLI backend plugin metadata.
- Overrides (optional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment (paths are injected into the prompt). Off by default in Docker recipes.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as CLI args instead of prompt injection.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (or `"list"`) to control how image args are passed when `IMAGE_ARG` is set.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate resume flow.
  - `OPENCLAW_LIVE_CLI_BACKEND_CACHE_PROBE=1` to run a fresh Claude CLI turn, a tool-bearing warmup resume, and a no-tool settlement resume before requiring at least 90% prompt-cache reuse on the following dirty-workspace resume. It also verifies that a thinking-level change rotates the live-session generation and that the next steady resume restores at least 90% reuse. This probe disables the image, MCP, and model-switch probes.
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE=1` to opt into the Claude Sonnet -> Opus same-session continuity probe when the selected model supports a switch target. Off by default, including in Docker recipes.
  - `OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE=1` to opt into the MCP/tool loopback probe. Off by default in Docker recipes.

Example:

```bash
  OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

Cheap Gemini MCP config smoke:

```bash
OPENCLAW_LIVE_TEST=1 \
  pnpm test:live src/agents/cli-runner/bundle-mcp.gemini.live.test.ts
```

This does not ask Gemini to generate a response. It writes the same system
settings OpenClaw gives Gemini, then runs `gemini --debug mcp list` to prove a
saved `transport: "streamable-http"` server is normalized to Gemini's HTTP MCP
shape and can connect to a local streamable-HTTP MCP server.

Docker recipe:

```bash
pnpm test:docker:live-cli-backend
```

Single-provider Docker recipes:

```bash
pnpm test:docker:live-cli-backend:claude
pnpm test:docker:live-cli-backend:claude:cache
pnpm test:docker:live-cli-backend:claude-subscription
pnpm test:docker:live-cli-backend:gemini
```

Notes:

- The Docker runner lives at `scripts/test-live-cli-backend-docker.sh`.
- `pnpm test:docker:live-cli-backend:claude:cache` requires Anthropic API-key auth. It logs normalized cache usage for every cache-probe resume and requires at least 90% reuse on both the post-settlement dirty-workspace resume and the steady resume after a thinking-level change.
- It runs the live CLI-backend smoke inside the repo Docker image as the non-root `node` user.
- It resolves CLI smoke metadata from the owning plugin, then installs the matching Linux CLI package (`@anthropic-ai/claude-code` or `@google/gemini-cli`) into a cached writable prefix at `OPENCLAW_DOCKER_CLI_TOOLS_DIR` (default: `~/.cache/openclaw/docker-cli-tools`).
- `codex-cli` is no longer a bundled CLI backend; use `openai/*` with the Codex app-server runtime instead (see [Live: Codex app-server harness smoke](/help/testing-live/acp-and-codex#live-codex-app-server-harness-smoke)).
- `pnpm test:docker:live-cli-backend:claude-subscription` requires portable Claude Code subscription OAuth through either `~/.claude/.credentials.json` with `claudeAiOauth.subscriptionType` or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. It first proves direct `claude -p` in Docker, then runs two Gateway CLI-backend turns without preserving Anthropic API-key env vars. This subscription lane disables the Claude MCP/tool and image probes by default because it consumes the signed-in subscription's usage limits and Anthropic can change Claude Agent SDK / `claude -p` billing and rate-limit behavior without an OpenClaw release.
- Claude and Gemini support the same probe set (text turn, image classification, MCP `automations` tool call, model-switch continuity) through the flags above, but none of those probes run by default - opt in per flag as needed.

## Live: APNs HTTP/2 proxy reachability

- Test: `src/infra/push-apns-http2.live.test.ts`
- Goal: tunnel through a local HTTP CONNECT proxy to Apple's sandbox APNs endpoint, send the APNs HTTP/2 validation request, and assert Apple's real `403 InvalidProviderToken` response comes back through the proxy path.
- Enable:
  - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_APNS_REACHABILITY=1 pnpm test:live src/infra/push-apns-http2.live.test.ts`
- Optional timeout:
  - `OPENCLAW_LIVE_APNS_TIMEOUT_MS=30000`
