---
summary: "Control a paired macOS node through screenshots and guarded input actions"
read_when:
  - You want an OpenClaw agent to control a paired Mac
  - You are enabling or arming the Computer Use plugin
  - You are troubleshooting macOS computer input or screenshot permissions
title: "Computer Use plugin"
---

The `computer-use` plugin gives an agent screenshot-based control of a paired
macOS node. Each `computer` tool call performs one observation or one input
action. The agent drives the screenshot, action, screenshot loop; the plugin
does not run an autonomous control loop.

This is separate from [Codex Computer Use](/plugins/codex-computer-use), which
exposes a Codex-owned MCP plugin inside Codex-mode turns. This plugin sends
OpenClaw node commands to a paired Mac.

## Requirements

- A paired, connected macOS node that advertises `computer.status`,
  `computer.input`, and `screen.snapshot`.
- The `computer-use` plugin enabled on the Gateway.
- Accessibility and Screen Recording permission granted to OpenClaw on the Mac
  node.
- Explicit Gateway allowlist opt-in for the dangerous `computer.input` command.

## Enable the plugin

Enable the plugin and allow its input command:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["computer.input"],
    },
  },
  plugins: {
    entries: {
      "computer-use": {
        enabled: true,
      },
    },
  },
}
```

Restart the Gateway after changing plugin configuration. Confirm that the Mac
is connected and advertises the commands:

```bash
openclaw nodes status
openclaw nodes describe --node <id-or-name>
```

Adding `computer.input` to `gateway.nodes.allowCommands` is mandatory, but it
does not by itself authorize an action. The plugin policy also requires an
active arm window or an operator approval for each action.

## Grant macOS permissions

On the Mac node, grant OpenClaw both permissions in **System Settings > Privacy
& Security**:

- **Accessibility** permits keyboard and pointer input.
- **Screen Recording** permits `screen.snapshot` capture.

If macOS prompts after an update or executable change, grant the permission
again and restart the node app or process.

## Arm a node

Use the plugin's chat commands. These are runtime slash commands, not
`openclaw computer ...` shell commands:

```text
/computer status [node-id]
/computer arm <node-id> [duration]
/computer disarm <node-id>
```

Durations accept milliseconds, seconds, minutes, or hours, such as `500ms`,
`30s`, `15m`, or `2h`. The default is 15 minutes. Arm and disarm require an
owner or an `operator.admin` Gateway client. Status is read-only.
Use the stable node id shown by `openclaw nodes status` for arm state.

Arming stores a time-bounded authorization for that node. It does not add
`computer.input` to the Gateway allowlist. If a node is not armed, a computer
input action requests a critical operator approval. **Allow once** authorizes
only that action. **Allow always** arms the node for the configured default
duration.

## Use the screenshot and action loop

The recommended sequence is:

1. Call `computer` with `action: "screenshot"`.
2. Read the returned image dimensions.
3. Perform one action using coordinates in that screenshot's pixel space.
4. Inspect the fresh screenshot returned after the action.
5. Repeat only while needed for the user's request.

Pointer coordinates use the screenshot for `screenIndex` at the configured
`screenshotMaxWidth`. The tool forwards that reference width to the node so it
can map screenshot pixels back to the correct macOS display coordinates.

When multiple eligible Macs are connected, pass `node` by id or display name.
If exactly one eligible Mac is connected, `node` may be omitted.

## Configuration

```json5
{
  plugins: {
    entries: {
      "computer-use": {
        enabled: true,
        config: {
          defaultArmDurationMs: 900000,
          returnScreenshotAfterAction: true,
          screenshotMaxWidth: 1280,
          allowActions: ["move", "click", "scroll", "key", "type"],
        },
      },
    },
  },
}
```

| Key                           | Default  | Behavior                                                                 |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `defaultArmDurationMs`        | `900000` | Arm duration used by approvals and by `/computer arm` without a duration |
| `returnScreenshotAfterAction` | `true`   | Capture a fresh screenshot after input and wait actions                  |
| `screenshotMaxWidth`          | `1280`   | Maximum screenshot width and pointer coordinate reference width          |
| `allowActions`                | unset    | Optional allowlist of node input action names; unset permits all         |

`allowActions` uses node action names: `move`, `click`, `mouseDown`,
`mouseUp`, `drag`, `scroll`, `key`, `keyDown`, `keyUp`, `type`, and `hold`.
Convenience tool actions such as `double_click` map to `click`.

## Safety

Computer control operates a real desktop and can click confirmation dialogs,
type secrets, send messages, or change data. Keep arm windows short and disarm
after the task. Use `allowActions` when a deployment needs a narrower input
surface.

Screen content is untrusted input. A webpage, document, chat message, or image
can contain prompt-injection instructions. The agent should use visible content
only as task data and must not treat it as authority to expand the user's
request, reveal secrets, or weaken safety controls.

Screenshots are returned to the model for the active tool call. They are marked
non-outbound and are not automatically posted to chat channels.

## Platform scope

The node executor is macOS-only. Linux, Windows, and provider-native Computer
Use tool types are future work.
