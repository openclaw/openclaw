---
summary: "Human in the Loop approvals (HITL.sh) for outbound sends and sensitive plugin HTTP routes"
read_when:
  - You want human approval before outbound messages are sent
  - You want to gate sensitive plugin HTTP routes with a reviewer
title: "HITL approvals"
---

# HITL approvals

OpenClaw can require a **human review** (via [HITL.sh](https://docs.hitl.sh/api-reference/introduction)) before it performs outbound side effects (message sends) and before it dispatches selected plugin HTTP routes.

This is designed to be **fail-closed**: when approvals are enabled and required but HITL is unavailable, OpenClaw blocks the action.

## What gets gated

- **Outbound sends**: `deliverOutboundPayloads` is the central enforcement seam, so this covers sends triggered by the CLI, tools, auto-replies, and gateway methods.
- **Plugin HTTP routes**: plugin routes registered via `registerHttpRoute` require **gateway auth by default** and can optionally require HITL approval per route.

## Gateway callback endpoint

When you create a HITL request, set `callback_url` so HITL can notify the Gateway when the request completes.

OpenClaw exposes:

- `POST /hitl/callback/<callbackSecret>`

Configure a long random `callbackSecret` and a public `callbackUrl` that points to your Gateway (HTTPS strongly recommended).

## Config

Minimal example:

```json5
{
  approvals: {
    hitl: {
      enabled: true,
      apiKey: "${HITL_API_KEY}",
      loopId: "YOUR_LOOP_ID",
      callbackSecret: "${HITL_CALLBACK_SECRET}",
      callbackUrl: "https://gateway.example.com/hitl/callback/${HITL_CALLBACK_SECRET}",
      timeoutSeconds: 120,
      defaultDecision: "deny",
      outbound: {
        mode: "on-miss",
        allowlist: [
          // Example: allowlist common system destinations (patterns are matched against a stable key)
          // "outbound:slack:to=C123:**"
        ],
      },
      pluginHttp: {
        mode: "off",
      },
    },
  },
}
```

Notes:

- `defaultDecision: "deny"` is the recommended baseline.
- `outbound.mode`:
  - `off`: no gating
  - `on-miss`: gate unless allowlisted
  - `always`: gate unless allowlisted
- When a reviewer selects **Allow always**, OpenClaw writes a persistent allowlist entry to `~/.openclaw/hitl-approvals.json`.

## Plugin HTTP routes

Gateway auth is enforced for plugin HTTP routes by default. A plugin route can opt out by registering with `public: true` (use sparingly).

A route can opt into HITL by registering with `requireHitlApproval: true`. When enabled and `approvals.hitl.pluginHttp.mode` is not `off`, the Gateway will create a HITL request and wait for a reviewer decision before calling the route handler.

## Security recommendations

- Use an **HTTPS** `callbackUrl` (HITL webhooks include the reviewer decision).
- Treat `callbackSecret` like a credential (rotate it if you suspect exposure).
- Keep `defaultDecision: "deny"` and start with `outbound.mode: "on-miss"` plus a small allowlist.
