# OpenClaw Node Host Browser Rollout (Tailnet Only)

Date: 2026-03-08  
Scope: Railway gateway + dedicated node host + dedicated Chrome profile.

## 1) Railway environment contract

Set these in Railway service variables:

- `OPENCLAW_HOOKS_TOKEN=znguAYjJILLSF63ZtGdLRaLYJU4HAhjW`
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `OPENCLAW_GATEWAY_TOKEN=<strong-random-token>`
- `OPENCLAW_BROWSER_NODE=<paired-node-id-or-name>`

Set custom start command:

```bash
node openclaw.mjs gateway
```

## 2) Node host setup (browser machine)

Prereqs:

- Browser machine is on same tailnet as gateway.
- OpenClaw CLI installed on browser machine.
- Use a dedicated Chrome profile for automation.

Start node host in foreground:

```bash
openclaw node run --host <gateway-tailnet-host> --port 443 --display-name "ops-browser-node"
```

Or install as service:

```bash
openclaw node install --host <gateway-tailnet-host> --port 443 --display-name "ops-browser-node"
openclaw node restart
```

Approve/pin node from gateway side:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes describe --node ops-browser-node
```

## 3) Chrome extension relay setup (browser machine)

```bash
openclaw browser extension install
openclaw browser extension path
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked using printed extension path
4. Pin extension
5. In extension options set:
   - Relay port (default mapping)
   - Gateway token = value of `OPENCLAW_GATEWAY_TOKEN`

## 4) Validation commands

Run from gateway CLI environment:

```bash
openclaw nodes status
openclaw nodes describe --node "${OPENCLAW_BROWSER_NODE}"
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile chrome snapshot
```

## 5) Security guardrails

- Keep gateway and node host tailnet-only.
- Do not expose browser relay/control ports publicly.
- Use dedicated browser profile, not personal profile.
- Rotate gateway/hooks tokens if leaked.
