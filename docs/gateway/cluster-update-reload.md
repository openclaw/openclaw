---
summary: "Runbook for fixing device token mismatch during rolling Gateway updates"
read_when:
  - You see disconnected (1008): unauthorized: device token mismatch
  - You run more than one Gateway instance and need a safe rollout path
title: "Cluster update and reload"
---

# Cluster update and reload

Use this runbook when clients disconnect with:

`disconnected (1008): unauthorized: device token mismatch (rotate/reissue device token)`

## What this means

The client connected with a token that the target Gateway instance does not accept for that `deviceId` + role + scopes.

Common causes during cluster rollouts:

- The client is still using an old token after token rotation.
- The client was routed to a different Gateway instance with a different device pairing store.
- The client role or scopes changed, and the previous token no longer satisfies scope checks.

## Before you start

Run these checks on the instance that shows the failure:

```bash
openclaw gateway status
openclaw devices list
openclaw logs --follow
```

You should confirm:

- Gateway runtime is healthy (`Runtime: running`, `RPC probe: ok`).
- The target device exists in `openclaw devices list`.
- Logs show the exact mismatch message, not a general network failure.

## Rolling update procedure

1. Drain one Gateway instance from traffic.
2. Update that instance (choose your install type):

```bash
# Global install
npm i -g openclaw@latest
openclaw doctor
```

```bash
# Source checkout
openclaw update
```

3. Restart and verify:

```bash
openclaw gateway restart
openclaw gateway status
openclaw channels status --probe
```

4. Reissue tokens for affected devices on that instance:

```bash
openclaw devices list
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

For node clients, use `--role node` (and include `--scope` only when needed by your node policy).

5. Update the client with the new token, then reconnect.
6. Return this instance to traffic and continue to the next instance.

## Emergency repair path

If rotation does not recover the client:

```bash
openclaw devices revoke --device <deviceId> --role <role>
openclaw devices list
```

Then reconnect the client and approve the new pairing request:

```bash
openclaw devices approve <requestId>
```

## Cluster rules that prevent repeat incidents

- Keep WebSocket routing sticky per client device when using multiple Gateway instances.
- Treat pairing state as instance local state (`OPENCLAW_STATE_DIR`), not a shared cluster secret.
- Roll updates one instance at a time: drain, update, restart, verify, then rejoin.
- If you rotate tokens, rotate and redeploy client secrets in the same maintenance window.

## Verification checklist

After each instance rollout:

- `openclaw gateway status` is healthy.
- `openclaw channels status --probe` remains healthy.
- `openclaw logs --follow` no longer shows `device token mismatch`.
- Reconnected clients stay connected across reconnects.

## Related docs

- [Devices CLI](/cli/devices)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [Multiple gateways](/gateway/multiple-gateways)
- [Updating](/install/updating)
- [Gateway configuration hot reload](/gateway/configuration#config-hot-reload)
