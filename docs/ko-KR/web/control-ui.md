---
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/web/control-ui.md
workflow: 15
---

# Control UI (browser)

Control UI 는 작은 **Vite + Lit** single-page app 이며, Gateway 에서 제공됩니다:

- 기본값: `http://<host>:18789/`
- 선택적 prefix: `gateway.controlUi.basePath` 를 설정합니다 (예: `/openclaw`)

이는 **directly to the Gateway WebSocket** 을 동일 포트에서 통신합니다.

## Quick open (local)

Gateway 가 동일 컴퓨터에서 실행 중인 경우, 다음을 열고:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

페이지가 로드되지 않으면, 먼저 Gateway 를 시작합니다: `openclaw gateway`.

인증은 WebSocket handshake 중에 다음을 통해 제공됩니다:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Dashboard settings panel 을 통해 token 을 저장할 수 있습니다; passwords 는 유지되지 않습니다.
  Onboarding wizard 는 기본적으로 gateway token 을 생성하므로 처음 연결할 때 여기에 붙여넣으세요.

## Device pairing (first connection)

새 browser 또는 device 에서 Control UI 에 연결할 때, Gateway 는
**one-time pairing approval** 이 필요합니다 — `gateway.auth.allowTailscale: true` 로 동일 Tailnet 에 있더라도 마찬가지입니다. 이는 unauthorized access 를 방지하기 위한 보안 조치입니다.

**당신이 볼 것:** "disconnected (1008): pairing required"

**Device 를 승인하려면:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Approved 되면, device 는 remembered 이며, `openclaw devices revoke --device <id> --role <role>` 로 revoke 하지 않는 한 재승인이 필요하지 않습니다. [Devices CLI](/cli/devices) 참고.

**Notes:**

- Local connections (`127.0.0.1`) 는 자동 approved 입니다.
- Remote connections (LAN, Tailnet, 등) 은 명시적 승인이 필요합니다.
- 각 browser profile 은 고유 device ID 를 생성하므로, browser 를 전환하거나 browser data 를 clear 하면 재pairing 이 필요합니다.

## What it can do (today)

- Gateway WS 를 통해 model 과 Chat (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Stream tool calls + live tool output cards in Chat (agent events)
- Channels: WhatsApp/Telegram/Discord/Slack + plugin channels (Mattermost, 등) status + QR login + per-channel config (`channels.status`, `web.login.*`, `config.patch`)
- Instances: presence list + refresh (`system-presence`)
- Sessions: list + per-session thinking/verbose overrides (`sessions.list`, `sessions.patch`)
- Cron jobs: list/add/edit/run/enable/disable + run history (`cron.*`)
- Skills: status, enable/disable, install, API key updates (`skills.*`)
- Nodes: list + caps (`node.list`)
- Exec approvals: edit gateway or node allowlists + ask policy for `exec host=gateway/node` (`exec.approvals.*`)
- Config: view/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: apply + restart with validation (`config.apply`) and wake the last active session
- Config writes include a base-hash guard to prevent clobbering concurrent edits
- Config schema + form rendering (`config.schema`, including plugin + channel schemas); Raw JSON editor remains available
- Debug: status/health/models snapshots + event log + manual RPC calls (`status`, `health`, `models.list`)
- Logs: live tail of gateway file logs with filter/export (`logs.tail`)
- Update: run a package/git update + restart (`update.run`) with a restart report

Cron jobs panel notes:

- Isolated jobs 의 경우, delivery 는 announce summary 로 기본값이 설정됩니다. Internal-only runs 을 원하면 none 으로 전환할 수 있습니다.
- Channel/target fields 는 announce 를 선택할 때 나타납니다.
- Webhook mode 는 `delivery.mode = "webhook"` 과 `delivery.to` 를 valid HTTP(S) webhook URL 로 설정합니다.
- Main-session jobs 의 경우, webhook 과 none delivery modes 는 available 입니다.
- Advanced edit controls 는 delete-after-run, clear agent override, cron exact/stagger options, agent model/thinking overrides, 및 best-effort delivery toggles 을 포함합니다.
- Form validation 은 inline 이며 field-level errors 를 가집니다; invalid values 는 fixed 될 때까지 save button 을 비활성화합니다.
- `cron.webhookToken` 을 설정하여 dedicated bearer token 을 보냅니다. 생략되면 webhook 은 auth header 없이 전송됩니다.
- Deprecated fallback: stored legacy jobs with `notify: true` 은 migrated 될 때까지 `cron.webhook` 을 사용할 수 있습니다.

## Chat behavior

- `chat.send` 는 **non-blocking** 입니다: immediately `{ runId, status: "started" }` 로 ack 되고 response 는 `chat` events 를 통해 streams 됩니다.
- 동일 `idempotencyKey` 로 re-sending 은 실행 중일 때 `{ status: "in_flight" }` 를 반환하고, 완료 후 `{ status: "ok" }` 를 반환합니다.
- `chat.history` responses 는 UI safety 를 위해 size-bounded 입니다. Transcript entries 가 너무 클 때, Gateway 는 long text fields 를 truncate 하고, 무거운 metadata blocks 을 omit 하고, oversized messages 를 placeholder 로 교체할 수 있습니다 (`[chat.history omitted: message too large]`).
- `chat.inject` 는 session transcript 에 assistant note 를 추가하고 UI-only updates 를 위해 `chat` event 를 broadcasts 합니다 (no agent run, no channel delivery).
- Stop:
  - **Stop** 을 클릭합니다 (calls `chat.abort`)
  - `/stop` (또는 standalone abort phrases like `stop`, `stop action`, `stop run`, `stop openclaw`, `please stop`) 을 입력하여 out-of-band 를 abort 합니다
  - `chat.abort` 는 `{ sessionKey }` (no `runId`) 을 지원하여 해당 session 의 모든 active runs 을 abort 합니다
- Abort partial retention:
  - Run 이 aborted 될 때, partial assistant text 는 여전히 UI 에서 표시될 수 있습니다
  - Gateway 는 buffered output 이 존재할 때 aborted partial assistant text 를 transcript history 에 유지합니다
  - Persisted entries 는 abort metadata 를 포함하므로 transcript consumers 는 abort partials 를 normal completion output 과 구별할 수 있습니다

## Tailnet access (권장)

### Integrated Tailscale Serve (preferred)

Gateway 를 loopback 에 유지하고 Tailscale Serve 가 HTTPS 로 proxy 하도록 합니다:

```bash
openclaw gateway --tailscale serve
```

Open:

- `https://<magicdns>/` (또는 configured `gateway.controlUi.basePath`)

기본적으로, Control UI/WebSocket Serve requests 는 `gateway.auth.allowTailscale` 이 `true` 일 때 Tailscale identity headers (`tailscale-user-login`) 를 통해 authenticate 할 수 있습니다. OpenClaw 는 `tailscale whois` 로 `x-forwarded-for` address 를 resolve 하고 header 와 일치시켜 identity 를 verify 하고, loopback 이 Tailscale 의 `x-forwarded-*` headers 와 함께 요청할 때만 accept 합니다. `gateway.auth.allowTailscale: false` (또는 force `gateway.auth.mode: "password"`) 로 설정하여 Serve traffic 에 대해서도 token/password 인증을 요구합니다.
Tokenless Serve auth 는 gateway host 가 trusted 임을 가정합니다. Untrusted local code 가 해당 host 에서 실행될 수 있으면, token/password auth 를 require 합니다.

### Bind to tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Then open:

- `http://<tailscale-ip>:18789/` (또는 configured `gateway.controlUi.basePath`)

Token 을 UI settings 에 붙여넣습니다 (`connect.params.auth.token` 으로 전송).

## Insecure HTTP

Plain HTTP (`http://<lan-ip>` 또는 `http://<tailscale-ip>`) 로 dashboard 를 열면,
browser 는 **non-secure context** 에서 실행되며 WebCrypto 를 blocks 합니다. 기본적으로,
OpenClaw 는 device identity 없이 Control UI connections 를 **blocks** 합니다.

**권장 수정:** HTTPS (Tailscale Serve) 를 사용하거나 UI 를 locally 에서 여세요:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (gateway host 에서)

**Insecure-auth toggle behavior:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth` 는 Control UI device identity 또는 pairing checks 를 bypass 하지 않습니다.

**Break-glass only:**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth` 는 Control UI device identity checks 를 비활성화하며 severe security downgrade 입니다. Emergency use 후 quickly revert 하세요.

[Tailscale](/gateway/tailscale) 참고 HTTPS setup guidance.

## Building the UI

Gateway 는 `dist/control-ui` 에서 static files 를 제공합니다. 이들을 빌드합니다:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optional absolute base (when you want fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Local development 의 경우 (separate dev server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

그런 다음 UI 를 Gateway WS URL (예: `ws://127.0.0.1:18789`) 로 point 합니다.

## Debugging/testing: dev server + remote Gateway

Control UI 는 static files 입니다; WebSocket target 은 configurable 이며 HTTP origin 과 다를 수 있습니다. 이것은 handy 할 때 locally 에서 Vite dev server 를 원하지만 Gateway 는 다른 곳에서 실행됩니다.

1. UI dev server 를 시작합니다: `pnpm ui:dev`
2. URL like 를 열고:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Optional one-time auth (if needed):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notes:

- `gatewayUrl` 은 load 후에 localStorage 에 저장되고 URL 에서 removed 됩니다.
- `token` 은 localStorage 에 저장됩니다; `password` 는 memory 에만 유지됩니다.
- `gatewayUrl` 이 set 될 때, UI 는 config 또는 environment credentials 로 fallback 되지 않습니다.
  `token` (또는 `password`) 을 explicitly 제공합니다. Missing explicit credentials 는 error 입니다.
- Gateway 가 TLS 뒤에 있을 때 `wss://` 를 사용합니다 (Tailscale Serve, HTTPS proxy, 등).
- `gatewayUrl` 은 clickjacking 를 방지하기 위해 top-level window 에만 accepted 됩니다 (not embedded).
- Non-loopback Control UI deployments 는 `gateway.controlUi.allowedOrigins` 을 explicitly 설정해야 합니다 (full origins). 이것은 remote dev setups 를 포함합니다.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` 는 Host-header origin fallback mode 를 활성화하지만, 이는 dangerous security mode 입니다.

Example:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).
