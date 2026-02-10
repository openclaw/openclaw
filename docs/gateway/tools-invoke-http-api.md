---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Calling tools without running a full agent turn（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Building automations that need tool policy enforcement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Tools Invoke API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Tools Invoke (HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled, but gated by Gateway auth and tool policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /tools/invoke`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default max payload size is 2 MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authentication（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Uses the Gateway auth configuration. Send a bearer token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Authorization: Bearer <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Request body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tool": "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "args": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "sessionKey": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "dryRun": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tool` (string, required): tool name to invoke.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `action` (string, optional): mapped into args if the tool schema supports `action` and the args payload omitted it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `args` (object, optional): tool-specific arguments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and default agent, or `global` in global scope).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dryRun` (boolean, optional): reserved for future use; currently ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Policy + routing behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool availability is filtered through the same policy chain used by Gateway agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.profile` / `tools.byProvider.profile`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.allow` / `tools.byProvider.allow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- group policies (if the session key maps to a group or channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- subagent policy (when invoking with a subagent session key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a tool is not allowed by policy, the endpoint returns **404**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To help group policies resolve context, you can optionally set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-message-channel: <channel>` (example: `slack`, `telegram`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-account-id: <accountId>` (when multiple accounts exist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `200` → `{ ok: true, result }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `400` → `{ ok: false, error: { type, message } }` (invalid request or tool error)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `401` → unauthorized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `404` → tool not available (not found or not allowlisted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `405` → method not allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -sS http://127.0.0.1:18789/tools/invoke \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer YOUR_TOKEN' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "tool": "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "action": "json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "args": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
