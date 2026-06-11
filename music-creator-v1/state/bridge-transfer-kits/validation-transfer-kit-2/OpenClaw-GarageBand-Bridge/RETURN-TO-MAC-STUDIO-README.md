# OpenClaw GarageBand Safe Transfer Kit

Kit: validation-transfer-kit-2
Created: 2026-05-19T18:58:12.459Z
Source bridge root on Mac Studio:

```text
/Users/openclaw/openclaw/music-creator-v1/tmp-safe-bridge
```

Use this when the Mac Studio and MacBook do not share one editable synced folder.
It keeps the safer pull-agent design: no SSH, no Remote Login, and no arbitrary
shell command execution from OpenClaw.

## On the MacBook

1. Keep this whole `OpenClaw-GarageBand-Bridge` folder together.
2. Confirm Remote Login is off: System Settings > General > Sharing > Remote Login.
3. Right-click `00-RUN-ME-MACBOOK-SAFE-BRIDGE.command`.
4. Choose Open.
5. Let it finish.
6. Send this same `OpenClaw-GarageBand-Bridge` folder back to the Mac Studio.

## Back on the Mac Studio

Run:

```bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-import-transfer-return --return-root <returned-OpenClaw-GarageBand-Bridge-folder>
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-status
node music-creator-v1/scripts/music-creator-v1.mjs bridge-status
```

Only these returned subfolders are imported: `from-macbook/`, `sync/macbook/`,
and `logs/`. The import command does not execute returned files.
