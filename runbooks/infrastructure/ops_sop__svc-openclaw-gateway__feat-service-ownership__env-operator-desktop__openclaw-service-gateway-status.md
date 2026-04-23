---
doc_id: rbk_openclaw_gateway_service_ownership_status
title: OpenClaw gateway service ownership and status
type: ops_sop
lifecycle_state: active
owners:
  primary: platform
tags:
  - openclaw
  - openclaw-gateway
  - systemd
  - status
  - service-ownership
  - port-18789
aliases:
  - openclaw service status
  - openclaw gateway status
  - openclaw.service running
  - openclaw-gateway.service active
  - service active running
  - port 18789
scope:
  service: openclaw-gateway
  feature: service-ownership
  plugin: ""
  environments:
    - operator-desktop
validation:
  last_validated_at: "2026-04-22"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: "openclaw-safe-install README and runbook_memory README"
retrieval:
  synopsis: "Confirm that the `openclaw` user `openclaw-gateway.service` is the active listener on `127.0.0.1:18789` while the historical system `openclaw.service` stays disabled and inactive."
  hints:
    - openclaw-gateway.service
    - openclaw.service
    - active running
    - service ownership
    - 127.0.0.1:18789
    - ws://127.0.0.1:18789
    - http://127.0.0.1:18789/
    - systemctl --user -M openclaw@ status openclaw-gateway.service
    - systemctl status openclaw.service
    - ss -lptn 'sport = :18789'
  not_for:
    - signal transport debugging
    - model routing changes
    - gateway configuration edits
    - historical system-unit install plans
  commands:
    - systemctl --user -M openclaw@ status openclaw-gateway.service
    - systemctl --user -M openclaw@ is-enabled openclaw-gateway.service
    - systemctl --user -M openclaw@ is-active openclaw-gateway.service
    - systemctl status openclaw.service
    - systemctl is-enabled openclaw.service
    - systemctl is-active openclaw.service
    - ss -lptn 'sport = :18789'
    - loginctl enable-linger openclaw
---

# Purpose

Record the live ownership split for the OpenClaw gateway on this host and the exact checks that prove the gateway is running on port `18789`.

# Aliases

- `openclaw service status`
- `openclaw gateway status`
- `openclaw.service running`
- `openclaw-gateway.service active`
- `service active running`
- `port 18789`

# When to use

- After a reboot, logout, or service restart when you need to confirm which unit owns the live gateway.
- When `openclaw.service` and `openclaw-gateway.service` are both mentioned and you need the current runtime authority.
- When the gateway UI or Signal path looks stale and you want to rule out a listener collision on `127.0.0.1:18789`.
- When the operator desktop needs a quick status check without revisiting the full install plan.

# Prerequisites

- Local shell access on the operator desktop.
- `sudo` access, or access to the `openclaw` user manager through `systemctl --user -M openclaw@`.
- The `openclaw` user should have lingering enabled if the gateway must survive logouts and reboots.

# Signals / symptoms

- `systemctl status openclaw.service` shows the historical system unit running when it should be disabled and inactive.
- `systemctl --user -M openclaw@ status openclaw-gateway.service` does not show the user unit active.
- `ss -lptn 'sport = :18789'` shows no listener, or more than one OpenClaw-related listener.
- `http://127.0.0.1:18789/` does not serve the Control UI even though OpenClaw is installed.

# Triage

1. Check the live owner and listener:

   ```bash
   systemctl --user -M openclaw@ status openclaw-gateway.service
   systemctl status openclaw.service
   ss -lptn 'sport = :18789'
   ```

2. Compare the result with the documented current state:
   - `openclaw-gateway.service` under the `openclaw` user bus is the active persistent gateway.
   - `openclaw.service` stays disabled and inactive so it does not compete for `127.0.0.1:18789`.

3. If the user service vanished after logout or reboot, verify lingering:

   ```bash
   sudo loginctl enable-linger openclaw
   ```

# Mitigation

If the historical system service is still active, move back to the user service and keep only one listener on port `18789`.

```bash
sudo loginctl enable-linger openclaw
systemctl --user -M openclaw@ enable --now openclaw-gateway.service
systemctl --user -M openclaw@ status openclaw-gateway.service
systemctl status openclaw.service
ss -lptn 'sport = :18789'
```

If the system unit is running and colliding with the gateway, stop or disable it before relying on the user service.

# Validation

- `systemctl --user -M openclaw@ is-enabled openclaw-gateway.service` prints `enabled`.
- `systemctl --user -M openclaw@ is-active openclaw-gateway.service` prints `active`.
- `systemctl is-enabled openclaw.service` prints `disabled`.
- `systemctl is-active openclaw.service` prints `inactive`.
- `ss -lptn 'sport = :18789'` shows a single `openclaw-gateway` listener.
- `http://127.0.0.1:18789/` responds with the Control UI.
- `ws://127.0.0.1:18789` and `ws://[::1]:18789` are the live gateway endpoints.

# Rollback

The safe steady state is the user service owning port `18789`. Only return to the historical system unit if you are intentionally changing ownership and have first removed the listener collision.

```bash
systemctl --user -M openclaw@ stop openclaw-gateway.service
systemctl --user -M openclaw@ disable openclaw-gateway.service
systemctl start openclaw.service
systemctl status openclaw.service
ss -lptn 'sport = :18789'
```

# Related runbooks

- [OpenClaw safe host deployment README](/home/ebatter1/Documents/openclaw-safe-install/README.md)
- [Runbook memory backend README](/home/ebatter1/openclaw-upstream/runbook_memory/README.md)

# Change history

- 2026-04-22: Created a focused status runbook for the current `openclaw-gateway.service` ownership model and port `18789` listener check.
