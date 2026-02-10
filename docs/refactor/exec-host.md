---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Refactor plan: exec host routing, node approvals, and headless runner"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing exec host routing or exec approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing node runner + UI IPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding exec host security modes and slash commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Exec Host Refactor"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Exec host refactor plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `exec.host` + `exec.security` to route execution across **sandbox**, **gateway**, and **node**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep defaults **safe**: no cross-host execution unless explicitly enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Split execution into a **headless runner service** with optional UI (macOS app) via local IPC.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provide **per-agent** policy, allowlist, ask mode, and node binding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Support **ask modes** that work _with_ or _without_ allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cross-platform: Unix socket + token auth (macOS/Linux/Windows parity).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No legacy allowlist migration or legacy schema support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No PTY/streaming for node exec (aggregated output only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No new network layer beyond the existing Bridge + Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decisions (locked)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Config keys:** `exec.host` + `exec.security` (per-agent override allowed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Elevation:** keep `/elevated` as an alias for gateway full access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Ask default:** `on-miss`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approvals store:** `~/.openclaw/exec-approvals.json` (JSON, no legacy migration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Runner:** headless system service; UI app hosts a Unix socket for approvals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Node identity:** use existing `nodeId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Socket auth:** Unix socket + token (cross-platform); split later if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Node host state:** `~/.openclaw/node.json` (node id + pairing token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **macOS exec host:** run `system.run` inside the macOS app; node host service forwards requests over local IPC.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No XPC helper:** stick to Unix socket + token + peer checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key concepts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sandbox`: Docker exec (current behavior).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway`: exec on gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node`: exec on node runner via Bridge (`system.run`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Security mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deny`: always block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist`: allow only matches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `full`: allow everything (equivalent to elevated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ask mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: never ask.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `on-miss`: ask only when allowlist does not match.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `always`: ask every time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ask is **independent** of allowlist; allowlist can be used with `always` or `on-miss`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Policy resolution (per exec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Resolve `exec.host` (tool param → agent override → global default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Resolve `exec.security` and `exec.ask` (same precedence).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. If host is `sandbox`, proceed with local sandbox exec.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If host is `gateway` or `node`, apply security + ask policy on that host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Default safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default `exec.host = sandbox`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default `exec.security = deny` for `gateway` and `node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default `exec.ask = on-miss` (only relevant if security allows).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If no node binding is set, **agent may target any node**, but only if policy allows it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `exec.host` (optional): `sandbox | gateway | node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `exec.security` (optional): `deny | allowlist | full`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `exec.ask` (optional): `off | on-miss | always`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `exec.node` (optional): node id/name to use when `host=node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config keys (global)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.host`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.security`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.ask`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.exec.node` (default node binding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config keys (per agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].tools.exec.host`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].tools.exec.security`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].tools.exec.ask`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].tools.exec.node`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Alias（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated on` = set `tools.exec.host=gateway`, `tools.exec.security=full` for the agent session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated off` = restore previous exec settings for the agent session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Approvals store (JSON)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Path: `~/.openclaw/exec-approvals.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Purpose:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local policy + allowlists for the **execution host** (gateway or node runner).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask fallback when no UI is available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- IPC credentials for UI clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Proposed schema (v1):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "version": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "socket": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "path": "~/.openclaw/exec-approvals.sock",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "token": "base64-opaque-token"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "security": "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "ask": "on-miss",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "askFallback": "deny"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "agent-id-1": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "security": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "ask": "on-miss",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowlist": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "pattern": "~/Projects/**/bin/rg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "lastUsedAt": 0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "lastUsedCommand": "rg -n TODO",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No legacy allowlist formats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `askFallback` applies only when `ask` is required and no UI is reachable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File permissions: `0600`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Runner service (headless)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Role（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enforce `exec.security` + `exec.ask` locally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Execute system commands and return output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Emit Bridge events for exec lifecycle (optional but recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Service lifecycle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Launchd/daemon on macOS; system service on Linux/Windows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approvals JSON is local to the execution host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI hosts a local Unix socket; runners connect on demand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## UI integration (macOS app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### IPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unix socket at `~/.openclaw/exec-approvals.sock` (0600).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token stored in `exec-approvals.json` (0600).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Peer checks: same-UID only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Challenge/response: nonce + HMAC(token, request-hash) to prevent replay.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Short TTL (e.g., 10s) + max payload + rate limit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Ask flow (macOS app exec host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Node service receives `system.run` from gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Node service connects to the local socket and sends the prompt/exec request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. App validates peer + token + HMAC + TTL, then shows dialog if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. App executes the command in UI context and returns output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Node service returns output to gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If UI missing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Apply `askFallback` (`deny|allowlist|full`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Diagram (SCI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agent -> Gateway -> Bridge -> Node Service (TS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                         |  IPC (UDS + token + HMAC + TTL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                         v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                     Mac App (UI + TCC + system.run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Node identity + binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use existing `nodeId` from Bridge pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Binding model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `tools.exec.node` restricts the agent to a specific node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If unset, agent can pick any node (policy still enforces defaults).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node selection resolution:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `nodeId` exact match（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `displayName` (normalized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `remoteIp`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `nodeId` prefix (>= 6 chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Eventing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Who sees events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System events are **per session** and shown to the agent on the next prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stored in the gateway in-memory queue (`enqueueSystemEvent`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Event text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Exec started (node=<id>, id=<runId>)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + optional output tail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Exec denied (node=<id>, id=<runId>, <reason>)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Transport（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option A (recommended):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runner sends Bridge `event` frames `exec.started` / `exec.finished`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway `handleBridgeEvent` maps these into `enqueueSystemEvent`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option B:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway `exec` tool handles lifecycle directly (synchronous only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sandbox host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Existing `exec` behavior (Docker or host when unsandboxed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PTY supported in non-sandbox mode only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway process executes on its own machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enforces local `exec-approvals.json` (security/ask/allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Node host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway calls `node.invoke` with `system.run`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runner enforces local approvals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runner returns aggregated stdout/stderr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional Bridge events for start/finish/deny.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output caps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cap combined stdout+stderr at **200k**; keep **tail 20k** for events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Truncate with a clear suffix (e.g., `"… (truncated)"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Slash commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent, per-session overrides; non-persistent unless saved via config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated on|off|ask|full` remains a shortcut for `host=gateway security=full` (with `full` skipping approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cross-platform story（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The runner service is the portable execution target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI is optional; if missing, `askFallback` applies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows/Linux support the same approvals JSON + socket protocol.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Implementation phases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 1: config + exec routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add config schema for `exec.host`, `exec.security`, `exec.ask`, `exec.node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update tool plumbing to respect `exec.host`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `/exec` slash command and keep `/elevated` alias.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 2: approvals store + gateway enforcement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Implement `exec-approvals.json` reader/writer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enforce allowlist + ask modes for `gateway` host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add output caps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 3: node runner enforcement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update node runner to enforce allowlist + ask.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add Unix socket prompt bridge to macOS app UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wire `askFallback`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 4: events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add node → gateway Bridge events for exec lifecycle.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Map to `enqueueSystemEvent` for agent prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 5: UI polish（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mac app: allowlist editor, per-agent switcher, ask policy UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node binding controls (optional).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unit tests: allowlist matching (glob + case-insensitive).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unit tests: policy resolution precedence (tool param → agent override → global).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Integration tests: node runner deny/allow/ask flows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bridge event tests: node event → system event routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open risks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI unavailability: ensure `askFallback` is respected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Long-running commands: rely on timeout + output caps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-node ambiguity: error unless node binding or explicit node param.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Exec tool](/tools/exec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Exec approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nodes](/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Elevated mode](/tools/elevated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
