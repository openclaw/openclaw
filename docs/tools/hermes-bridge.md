---
title: Hermes Bridge
summary: Local delegation bridge where Hermes Agent plans and OpenClaw executes approved task templates.
read_when:
  - Connecting Hermes Agent to OpenClaw without merging runtimes
  - Allowing a local orchestrator to invoke approved OpenClaw task templates
  - Reviewing the Hermes bridge threat model, mock mode, or HTTP contract
---

# Hermes Bridge

The Hermes bridge is a bundled OpenClaw plugin for local delegation. Hermes Agent remains the planner, memory owner, scheduler, and high-level orchestrator. OpenClaw remains the gateway and tool executor. The two runtimes stay separate.

The real Hermes Agent repository must be present at `../hermes-agent` for the real integration. Mock Hermes clients are retained only for tests and offline demos.

The bridge is intentionally narrow in v1:

- It is disabled by default.
- It defaults to mock mode.
- It requires normal Gateway authentication.
- It also requires a plugin-local shared secret in `x-openclaw-hermes-token`.
- It accepts only declared task template IDs.
- It does not expose raw `/tools/invoke`.
- It does not run email, calendar, messaging, trading, filesystem mutation, shell, browser, node, cron, or Gateway-control tasks.

## Why a Plugin

The native plugin surface can express the bridge cleanly with `registerHttpRoute` and an optional `hermes_bridge` tool. That is the least invasive safe integration point because the route, shared secret, task registry, allowlist, executor, tests, and docs stay plugin-owned.

The lower-priority alternatives are deliberately avoided in v1:

- `/tools/invoke` is too broad for a persistent external orchestrator because it is a full operator-access endpoint.
- Gateway WebSocket protocol changes would widen a core protocol surface for a local bridge that does not need protocol changes.
- A CLI wrapper would be harder to authenticate, observe, and constrain than a plugin route.
- Core code changes are unnecessary while the plugin SDK can express the contract.

## Configuration

Enable the plugin explicitly and allow only the task templates Hermes may call:

```json
{
  "plugins": {
    "hermes-bridge": {
      "enabled": true,
      "mode": "mock",
      "hermesMode": "real",
      "hermesAgentPath": "../hermes-agent",
      "sharedSecretEnv": "OPENCLAW_HERMES_BRIDGE_TOKEN",
      "allowedTasks": [
        "status.echo",
        "status.health",
        "message.preview",
        "tasks.organize_today",
        "agents.ask_team"
      ],
      "allowedTools": [],
      "maxRequestBytes": 65536
    }
  }
}
```

Set the bridge token in the OpenClaw Gateway environment:

```bash
export OPENCLAW_HERMES_BRIDGE_TOKEN="replace-with-a-local-secret"
export HERMES_AGENT_PATH="../hermes-agent"
export HERMES_MODE="mock"
export OPENCLAW_GATEWAY_URL="http://127.0.0.1:1455"
```

Do not reuse the Gateway bearer token as the Hermes bridge token. Gateway auth and the bridge token are separate controls.

Verify the real Hermes checkout before relying on the bridge:

```bash
HERMES_AGENT_PATH=../hermes-agent COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:agent:check
```

Current verified checkout:

- Path: `../hermes-agent`
- Remote: `https://github.com/NousResearch/hermes-agent.git`
- Commit: `745c4db235bdb09beb19564f66727dc1f43e4fe2`

## HTTP Contract

Hermes calls the plugin-owned route:

```http
POST /api/plugins/hermes-bridge/tasks
Authorization: Bearer <gateway-token>
x-openclaw-hermes-token: <bridge-token>
Content-Type: application/json
```

Request:

```json
{
  "requestId": "optional-idempotency-key",
  "taskId": "status.echo",
  "requestedBy": "hermes",
  "intent": "Echo a local test message.",
  "priority": "normal",
  "requiresConfirmation": false,
  "allowedTools": [],
  "dryRun": true,
  "input": { "message": "hello" }
}
```

Response:

```json
{
  "ok": true,
  "requestId": "optional-idempotency-key",
  "idempotencyKey": "optional-idempotency-key",
  "taskId": "status.echo",
  "mode": "mock",
  "status": "succeeded",
  "summary": "Hermes bridge task succeeded: status.echo",
  "artifacts": [],
  "auditLog": [],
  "output": { "message": "hello" }
}
```

Error responses keep the same envelope and include `error.type` and `error.message`.

## V1 Tasks

`status.echo` returns the supplied `input.message`.

`status.health` returns bridge health metadata.

`message.preview` builds a message preview and returns `wouldSend: false`. It never sends a message.

`tasks.organize_today` is the MVP dry-run task organizer. It requires `dryRun: true`, requires no tools, and returns `summary: "Dry-run completed. No external side effects were performed."`

`agents.ask_team` is the dry-run OpenClaw agent team delegation template. It requires `dryRun: true`, requires no tools, does not start live agents, and returns `summary: "Dry-run completed. No OpenClaw agents were started."`

`message.send` is a mock-only future send template. It requires explicit confirmation and `telegram.send` in both bridge config `allowedTools` and request `allowedTools`; it still never sends a message in v1.

All v1 tasks are mock-safe. If `mode` is configured as `live`, v1 task execution still reports `mode: "mock"` because no live task template exists yet.

If `hermesMode` is configured as `real`, non-dry-run requests for mock-only templates are rejected with `real_task_unavailable`. This prevents mock execution from being treated as the completed real integration.

## Optional Tool

When the plugin is enabled, OpenClaw can expose the optional `hermes_bridge` tool if the operator allows it. The tool supports:

- `status`
- `list_tasks`
- `invoke_mock`

The tool exists for local testing and agent-visible status. Hermes should use the HTTP route as the primary contract.

## Threat Model

The bridge is for localhost or private-network delegation from a trusted Hermes runtime. It is not a general remote automation API.

Hermes should never send arbitrary tool names or raw OpenClaw commands. OpenClaw should reject any task ID that is unknown or not allowlisted.

Live task templates require separate implementation, tests, docs, and review. A live template must declare the exact side effect it performs and keep the allowlist as the final execution gate.

## Remaining Real Adapter Work

The OpenClaw side now verifies and records the real Hermes checkout. The next PR should add the Hermes-side adapter in `../hermes-agent` using a documented Hermes extension surface. Do not guess undocumented Hermes runtime APIs, and do not enable real email, calendar, messaging, trading, shell, browser, filesystem, cron, or Gateway-control side effects without explicit confirmation and focused tests.
