---
summary: "Owner-only tool that captures the Gateway host screen and sends it to the current chat"
read_when:
  - You want the agent to send you a screenshot of the Gateway host
  - You need to enable or restrict the screenshot tool
  - You are choosing between screenshot, computer use, and the browser tool
title: "Screenshot"
sidebarTitle: "Screenshot"
---

The bundled `screenshot` plugin adds one agent tool, `screenshot`. It captures
the Gateway host's whole desktop, saves a PNG under `screenshots/` in the agent
workspace, and sends the image to the conversation that asked for it.

| Property  | Value                                                           |
| --------- | --------------------------------------------------------------- |
| Plugin id | `screenshot`                                                    |
| Tool      | `screenshot` (optional, owner-only)                             |
| Platforms | Windows (PowerShell) and macOS (`screencapture`)                |
| Output    | `<workspace>/screenshots/screenshot-<timestamp>.png`            |
| Parameter | `send` (boolean, default `true`); `false` saves without sending |

The image is delivered to the chat but is not returned to the model, so a cloud
model never sees your screen through this tool. Linux hosts are not supported.

## Enable it

The tool is optional and off until you enable the plugin and allow the tool:

```json5
{
  plugins: { entries: { screenshot: { enabled: true } } },
  tools: { alsoAllow: ["screenshot"] },
}
```

`alsoAllow` adds the tool on top of the active tool profile without restricting
other tools. Use `tools.allow` only if you want a restrictive allowlist.

## Restrict who can use it

A screenshot exposes whatever is on screen, so the tool is built only for the
verified owner of the current turn. A sender who is merely allowed to chat never
receives it, and sandboxed sessions never receive it.

Owner status comes from the command owner list. For Telegram, list your numeric
user ID in both places so only you can reach the bot and only you can use owner
tools:

```json5
{
  channels: {
    telegram: {
      dmPolicy: "allowlist",
      allowFrom: ["<your-numeric-telegram-user-id>"],
    },
  },
  commands: { ownerAllowFrom: ["telegram:<your-numeric-telegram-user-id>"] },
}
```

See [Telegram access control](/channels/telegram/access-control) for how DM
policy, `allowFrom`, and owner commands relate.

## Requirements

- The Gateway must run inside a desktop session, for example from a terminal in
  your logged-in desktop. A Gateway without a desktop session, such as a
  Windows service or an SSH-started process, may have no screen to capture; the
  tool then reports that no image was produced.
- The channel must support direct delivery of media. When it does not, the tool
  saves the file and reports that it was not sent.
- Attachment delivery follows the normal [media rules](/reference/rich-output-protocol).

## Related

- [Computer use](/nodes/computer-use) drives a desktop on a paired node and keeps its screenshots model-only.
- [Browser](/tools/browser) captures web pages rather than the desktop.
- [Screen](/tools/screen) arranges Control UI panels and does not capture images.
