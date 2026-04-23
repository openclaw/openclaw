---
doc_id: rbk_tailscale_boot_persistence_operator_desktop
title: Keep Tailscale connected at boot
type: change_record
lifecycle_state: active
owners:
  primary: platform
tags:
  - tailscale
  - systemd
  - tailnet
  - networking
aliases:
  - tailscale boot
  - tailscale auto-start
  - tailscaled auto-start
scope:
  service: tailscale
  feature: boot-persistence
  plugin: ""
  environments:
    - operator-desktop
validation:
  last_validated_at: "2026-04-13"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: local systemd enablement and tailnet verification on 2026-04-13
retrieval:
  synopsis: Keep `tailscaled` enabled on boot and the host joined to the tailnet after reboot.
  hints:
    - systemctl enable --now tailscaled
    - systemctl is-enabled tailscaled
    - tailscale status
  not_for:
    - tailscale serve
    - tailscale funnel
    - gateway exposure
    - openclaw gateway remote access
  commands:
    - systemctl enable --now tailscaled
    - systemctl is-enabled tailscaled
    - systemctl is-active tailscaled
    - tailscale status
    - sudo tailscale up
---

# Purpose

Keep `tailscaled` enabled on boot so the host reconnects to the tailnet after reboot.

# Aliases

- `tailscale boot`
- `tailscale auto-start`
- `tailscaled auto-start`

# When to use

- After installing or repairing Tailscale.
- If the host drops off the tailnet after reboot.
- If `tailscaled` is running but not enabled on boot.

# Prerequisites

- `tailscale` CLI and `tailscaled` systemd unit are installed.
- Root or `sudo` access is available.
- The host already has a valid tailnet login, or you can re-run `sudo tailscale up`.

# Mitigation

```bash
sudo systemctl enable --now tailscaled
systemctl is-enabled tailscaled
systemctl is-active tailscaled
tailscale status
```

If `tailscale status` shows the host is not authenticated:

```bash
sudo tailscale up
```

# Validation

- `systemctl is-enabled tailscaled` prints `enabled`.
- `systemctl is-active tailscaled` prints `active`.
- `tailscale status` lists this host on the tailnet.
- After reboot, the same checks still pass without a manual start.

# Rollback

```bash
sudo systemctl disable --now tailscaled
```

If you also need to disconnect immediately:

```bash
sudo tailscale down
```

# Change history

- 2026-04-13: Enabled `tailscaled` at boot on the operator desktop and confirmed tailnet connectivity.
