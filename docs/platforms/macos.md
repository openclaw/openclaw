---
summary: "Install and use the OpenClaw macOS menu bar app"
read_when:
  - Installing the macOS app
  - Deciding between local and remote Gateway mode on macOS
  - Looking for macOS app release downloads
title: "macOS app"
---

The macOS app is the OpenClaw **menu bar companion**. Use it when you want a
native tray UI, macOS permission prompts, notifications, WebChat, voice input,
Canvas, or Mac-hosted node tools such as `system.run`.

If you only need the CLI and Gateway, start with [Getting started](/start/getting-started).

## Download

Download macOS app builds from the
[OpenClaw GitHub releases](https://github.com/openclaw/openclaw/releases).
When a release includes macOS app assets, look for:

- `OpenClaw-<version>.dmg` (preferred)
- `OpenClaw-<version>.zip`

Some releases only include CLI, evidence, or Windows assets. If the newest
release has no macOS app asset, use the newest release that does, or build the
app from source with [macOS dev setup](/platforms/mac/dev-setup).

## First run

1. Install and launch **OpenClaw.app**.
2. Complete the macOS permission checklist.
3. Pick **Local** or **Remote** mode.
4. Install the `openclaw` CLI if the app asks for it.
5. Open WebChat from the menu bar and send a test message.

For the CLI/Gateway setup path, use [Getting started](/start/getting-started).
For permission recovery, use [macOS permissions](/platforms/mac/permissions).

## Choose a Gateway mode

| Mode   | Use it when                                                                             | Detail page                                        |
| ------ | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Local  | This Mac should run the Gateway and keep it alive with launchd.                         | [Gateway on macOS](/platforms/mac/bundled-gateway) |
| Remote | Another host runs the Gateway and this Mac should control it over SSH, LAN, or Tailnet. | [Remote control](/platforms/mac/remote)            |

Local mode requires an installed `openclaw` CLI. The app can install it, or you
can follow [Gateway on macOS](/platforms/mac/bundled-gateway).

## What the app owns

- Menu bar status, notifications, health, and WebChat.
- macOS permission prompts for screen, microphone, speech, automation, and accessibility.
- Local node tools such as Canvas, camera/screen capture, notifications, and `system.run`.
- Exec approval prompts for Mac-hosted commands.
- Remote-mode SSH tunnels or direct Gateway connections.

The app does **not** replace the OpenClaw Gateway or general CLI docs. Core
Gateway configuration, providers, plugins, channels, tools, and security live in
their own docs.

## macOS detail pages

| Task                                     | Read                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Install or debug the CLI/Gateway service | [Gateway on macOS](/platforms/mac/bundled-gateway)                                          |
| Keep state out of cloud-synced folders   | [Gateway on macOS](/platforms/mac/bundled-gateway#state-directory-on-macos)                 |
| Debug app discovery and connectivity     | [Gateway on macOS](/platforms/mac/bundled-gateway#debug-app-connectivity)                   |
| Understand launchd behavior              | [Gateway lifecycle](/platforms/mac/child-process)                                           |
| Fix permissions or signing/TCC issues    | [macOS permissions](/platforms/mac/permissions)                                             |
| Connect to a remote Gateway              | [Remote control](/platforms/mac/remote)                                                     |
| Read menu bar status and health checks   | [Menu bar](/platforms/mac/menu-bar), [Health checks](/platforms/mac/health)                 |
| Use the embedded chat UI                 | [WebChat](/platforms/mac/webchat)                                                           |
| Use voice wake or push-to-talk           | [Voice wake](/platforms/mac/voicewake)                                                      |
| Use Canvas and Canvas deep links         | [Canvas](/platforms/mac/canvas)                                                             |
| Host PeekabooBridge for UI automation    | [Peekaboo bridge](/platforms/mac/peekaboo)                                                  |
| Configure command approvals              | [Exec approvals](/tools/exec-approvals), [advanced details](/tools/exec-approvals-advanced) |
| Inspect Mac node commands and app IPC    | [macOS IPC](/platforms/mac/xpc)                                                             |
| Capture logs                             | [macOS logging](/platforms/mac/logging)                                                     |
| Build from source                        | [macOS dev setup](/platforms/mac/dev-setup)                                                 |

## Related

- [Platforms](/platforms)
- [Getting started](/start/getting-started)
- [Gateway](/gateway)
- [Exec approvals](/tools/exec-approvals)
