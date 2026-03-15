---
summary: "DG-Lab community plugin: control DG-Lab (Coyote) V3 devices via WebSocket"
read_when:
  - You want to use DG-Lab (Coyote) V3 with OpenClaw
  - You need install and config steps for the DG-Lab plugin
title: "DG-Lab Plugin"
---

# DG-Lab Plugin (community)

`openclaw-plugin-dg-lab` is a community-maintained plugin for controlling
DG-Lab (Coyote) V3 devices through a WebSocket bridge.

See the plugin repository for source and updates:
`https://github.com/FengYing1314/openclaw-plugin-dg-lab`

## Install

```bash
openclaw plugins install openclaw-plugin-dg-lab
```

Restart Gateway after installation.

## Plugin ID

`openclaw-plugin-dg-lab`

## Config

Configure under `plugins.entries.openclaw-plugin-dg-lab.config`:

```json5
{
  plugins: {
    entries: {
      "openclaw-plugin-dg-lab": {
        enabled: true,
        config: {
          serverIp: "203.0.113.10",
          port: 18888,
          limitIntensity: 40,
        },
      },
    },
  },
}
```

Fields:

- `serverIp` (string): public IP/domain embedded in pairing QR code.
- `port` (number, default `18888`): plugin WebSocket server port.
- `limitIntensity` (number, default `40`): software-side intensity soft limit
  (`0` to `200`).

## Chat commands

- `/dg_qr`: generate DG-Lab pairing QR code.
- `/dg_emotion on|off`: toggle emotion-driven mode.
- `/dg_limit <0-200>`: set software intensity soft limit.
- `/dg_test <delta>`: send a test strength change.
- `/dg_status`: show connection and intensity status.
- `/dg_pulse ...`: waveform library management.

## Agent tools

- `dg_shock`: send stimulation on channel A/B with waveform selection.
- `dg_pulse_list`: list built-in and imported waveform presets.
- `dg_qr_generate`: generate a pairing QR image and return the local file path.

## Safety

This plugin controls electrical stimulation hardware.

- Start from low intensity.
- Respect device-side hardware limits in the DG-Lab app.
- Avoid dangerous body areas (chest/head/neck).
- Use at your own risk.
