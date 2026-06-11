# OpenClaw GarageBand Bridge

Bridge root:

```text
/Users/openclaw/Library/Mobile Documents/com~apple~CloudDocs/OpenClaw-GarageBand-Bridge
```

## Mac Studio

OpenClaw exports selected Music Creator V1 candidates, vocal layers, and source assets into `to-macbook/`.

## MacBook

1. Use a bridge folder that syncs both directions between the Mac Studio and MacBook. Different Apple IDs are fine only if the folder is shared with edit access or synced through another trusted tool.
2. Do not enable Remote Login for this bridge. `macbook-enable-remote-exec.command` is deprecated and is removed by default by `bridge-init`.
3. Run `macbook-disable-remote-exec.command` if you previously tested the Remote Login helper. It removes the old OpenClaw SSH key line from `authorized_keys` when present and reminds you to keep Remote Login off.
4. First prove sync: on the Mac Studio run `bridge-sync-probe`; after the probe syncs to the MacBook, run `macbook-sync-check.command`; then run `bridge-sync-status` on the Mac Studio.
5. Easiest safe start: run `macbook-start-safe-bridge.command`. It blocks if Remote Login is on, writes the sync reply, then processes one signed request.
6. Advanced/manual mode: run `macbook-pull-agent.command --once` to process exactly one signed request, or run `macbook-pull-agent.command` to keep polling until you close Terminal.
7. The pull agent verifies `macstudio-bridge-signing.pub.pem`, rejects expired or unsigned jobs, accepts only whitelisted actions, and never runs arbitrary shell commands.
8. Optional tokenless enrollment: on the Mac Studio, run `macstudio-open-node-enrollment.command`; while that short-lived window is open, run `macbook-pair-openclaw-node-window.command` on the MacBook.
9. Token fallback: run `macbook-pair-openclaw-node.command` on the MacBook and paste the Mac Studio Gateway token locally when prompted.
10. Run `macbook-finish-setup.command` to install/open GarageBand, install Valhalla Supermassive, validate the AU plugin, and write setup status back to `from-macbook/`.
11. To process Mac Studio jobs safely, queue a signed request on the Mac Studio with `bridge-queue-job`, then let the MacBook pull agent handle it.
12. To send an existing GarageBand bounce, stem, song, or vocal idea to OpenClaw, run `macbook-send-audio-to-openclaw.command`.

GarageBand App Store install, admin approval for system AU plugins, OpenClaw node service installation, project creation, and final bounce/export can require local UI action. The bridge keeps those manual points explicit instead of pretending they are fully autonomous.
