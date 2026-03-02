---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/web/dashboard.md
workflow: 15
---

# Dashboard (Control UI)

Gateway dashboard 는 기본값으로 `/` 에서 제공되는 browser Control UI 입니다
(`gateway.controlUi.basePath` 로 override 할 수 있음).

Quick open (local Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

Key references:

- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Authentication 은 WebSocket handshake 에서 `connect.params.auth` (token 또는 password) 를 통해 enforced 됩니다. [Gateway configuration](/gateway/configuration) 에서 `gateway.auth` 를 참고하세요.

Security note: Control UI 는 **admin surface** (chat, config, exec approvals) 입니다.
publicly 에 expose 하지 마세요. UI 는 첫 로드 후 token 을 `localStorage` 에 저장합니다.
Localhost, Tailscale Serve, 또는 SSH tunnel 을 선호합니다.

## Fast path (권장)

- Onboarding 후, CLI 는 auto-opens dashboard 이고 clean (non-tokenized) link 을 prints 합니다.
- Anytime 재열기: `openclaw dashboard` (copies link, opens browser if possible, shows SSH hint if headless).
- UI 가 auth 를 prompt 하면, `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`) 에서 Control UI settings 에 token 을 붙여넣으세요.

## Token basics (local vs remote)

- **Localhost**: open `http://127.0.0.1:18789/`.
- **Token source**: `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`); UI 는 연결 후 copy 를 localStorage 에 저장합니다.
- **Not localhost**: Tailscale Serve (tokenless for Control UI/WebSocket if `gateway.auth.allowTailscale: true`, assumes trusted gateway host; HTTP APIs 는 여전히 token/password 필요), tailnet bind with a token, 또는 SSH tunnel 을 사용합니다. [Web surfaces](/web) 를 참고하세요.

## If you see "unauthorized" / 1008

- Gateway 가 reachable 인지 확인합니다 (local: `openclaw status`; remote: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`).
- Gateway host 에서 token 을 retrieve 합니다: `openclaw config get gateway.auth.token` (또는 generate one: `openclaw doctor --generate-gateway-token`).
- Dashboard settings 에서, auth field 에 token 을 붙여넣은 다음 연결합니다.
