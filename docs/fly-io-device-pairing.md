# Device Pairing on Fly.io with Tailscale Serve

This guide explains how to approve device pairing requests when running OpenClaw on Fly.io with Tailscale Serve.

## Overview

When the Control UI (or any device) connects to the gateway for the first time, it creates a device pairing request that must be approved before the connection can proceed.

## Method 1: Approve via CLI (Recommended)

### Step 1: SSH into your Fly.io machine

```bash
fly ssh console -a openclaw-lisan-al-gaib
```

### Step 2: List pending device pairing requests

```bash
cd /app
node dist/index.js devices list --url ws://127.0.0.1:17568 --token $OPENCLAW_GATEWAY_TOKEN
```



This will show pending requests with their `requestId`, device ID, role, IP address, and age.

### Step 3: Approve the pairing request

```bash
node dist/index.js devices approve <requestId> --url ws://127.0.0.1:17568 --token $OPENCLAW_GATEWAY_TOKEN
```

Replace:
- `<requestId>` with the actual request ID from step 2
- `OPENCLAW_GATEWAY_TOKEN` with your gateway token

### Step 4: Verify the device is paired

```bash
node dist/index.js devices list --url ws://127.0.0.1:17568 --token $OPENCLAW_GATEWAY_TOKEN
```

The device should now appear in the "Paired" section instead of "Pending".

## Method 2: Approve via Control UI

### Prerequisites

First, enable insecure auth to allow token-based access without device pairing:

```bash
fly ssh console -a openclaw-lisan-al-gaib
cd /app
node dist/index.js config set gateway.controlUi.allowInsecureAuth true
exit
fly apps restart openclaw-lisan-al-gaib
```

### Steps

1. Open the Control UI at your Tailscale Serve URL:
   ```
   https://48e659eb767ee8-1.tail180196.ts.net/
   ```

2. In the "Gateway Access" card:
   - Set **WebSocket URL** to: `wss://48e659eb767ee8-1.tail180196.ts.net`
   - Set **Gateway Token** to your token
   - Click **Connect**

3. Once connected, go to the **"Nodes"** tab

4. Find your device in the "Pending" section

5. Click **"Approve"** next to the device


## Troubleshooting

### No pending requests shown

If `devices list` shows no pending requests, the request may have expired (they expire after some time). Try connecting from the Control UI again to create a new pairing request.

### Device ID from logs

From the gateway logs, you can see the device ID attempting to connect:
```
"deviceId":"5be7c2aeeea118e0ab38261a84db43c686ac74af2d3446a29ee3d8eee996d5f9"
```

Use this to identify the correct pairing request in the list.

### Connection still fails after approval

1. Verify the device is paired: `devices list` should show it in "Paired"
2. Check gateway logs for errors: `tail -50 /tmp/openclaw/openclaw-*.log`
3. Ensure `gateway.trustedProxies` includes `127.0.0.1` for Tailscale Serve
4. Ensure `gateway.auth.allowTailscale` is `true` if using Tailscale identity auth

## Configuration Reference

Your current gateway configuration should include:

```json
{
  "gateway": {
    "port": 17568,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "YOUR_TOKEN",
      "allowTailscale": true
    },
    "trustedProxies": ["127.0.0.1"],
    "tailscale": {
      "mode": "serve",
      "resetOnExit": true
    },
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
```

## Related Documentation

- [Device Pairing Overview](/start/pairing)
- [Gateway Security](/gateway/security)
- [Tailscale Integration](/gateway/tailscale)
- [Control UI](/web/control-ui)
