---
summary: "Capability-based desktop control through the computer tool and computer.act node command"
read_when:
  - Letting the gateway agent see and control a paired desktop
  - Arming, permissions, or safety for computer use
  - Extending the computer.act node command or its fulfillers
title: "Computer use"
---

Computer use lets the gateway agent see and control a capable paired desktop. Eligibility is capability-based: the connected node must advertise both `computer.act` and `screen.snapshot`, whose result must include a `displayFrameId`. The tool captures a screenshot as its reference frame, then drives the pointer and keyboard through the dangerous `computer.act` command. The action set follows the core Anthropic computer-use actions; optional `computer_20251124` zoom is not exposed. A vision-capable model drives it through the built-in `computer` agent tool.

The agent emits one uniform command, `computer.act`; it cannot tell how a node fulfills it. The bundled macOS app is currently the only shipped fulfiller and handles the command in-process with embedded Peekaboo services plus narrow CoreGraphics primitives (correct TCC permissions, no extra process). Windows and Linux desktop nodes may declare both `computer.act` and `screen.snapshot` under the same pairing and arming policy, but their platform apps do not fulfill desktop control yet. Future fulfillers can implement this command pair without changing the agent-facing contract.

## Requirements

- A paired, connected node advertising both `computer.act` and `screen.snapshot`, with `screen.snapshot` returning `displayFrameId`. Today, the bundled macOS app is the only shipped fulfiller.
- **macOS fulfiller:** app setting **Allow Computer Control** enabled (default: off).
- **macOS fulfiller:** **Accessibility** permission granted to OpenClaw (for pointer/keyboard injection) and **Screen Recording** permission (for `screen.snapshot`).
- The `computer.act` command armed on the gateway (it is dangerous and disarmed by default).
- A vision-capable agent model.
- Tool policy that exposes `computer`. The default `coding` profile does not. Add `computer` to `tools.alsoAllow`; sandboxed agents also need it in `tools.sandbox.tools.alsoAllow`.

## The `computer` agent tool

The built-in `computer` tool takes one action per call. Coordinates are non-negative integer pixels in the most recent screenshot; the node maps them to display points. Coordinate actions must echo the screenshot result's `frameId`, and an explicit `screenIndex` must match that frame. OpenClaw also carries a node-issued display identity from the screenshot into the action, so a display reconnect or geometry change fails closed instead of silently retargeting the same index. These checks reject guessed tokens and tokens from another delivered frame or display. A token is not a freshness guarantee: apps can change pixels on the same display after capture, so take a new screenshot whenever the scene may have changed.

- Reads: `screenshot`.
- Pointer: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag` (with `startCoordinate`), `left_mouse_down`, `left_mouse_up`.
- Scroll: `scroll` with `scrollDirection` (`up|down|left|right`) and `scrollAmount` (wheel ticks).
- Keyboard: `type` (text), `key` (combo such as `cmd+shift+t` or `Return`), `hold_key` (`text` combo held for `duration` seconds).
- Pacing: `wait` (`duration` seconds).

Modifier keys ride the `text` field on click and scroll actions (`shift`, `ctrl`, `alt`, `cmd`). After an input action the tool returns a fresh screenshot so the model can observe the result. If more than one computer-capable node is connected, pass `node` explicitly.

Screenshots are kept **model-only**: they are never auto-delivered to the chat channel. Treat all on-screen content as untrusted input; the tool warns the model not to follow on-screen instructions that conflict with the user's request.

## The `computer.act` node command

`computer.act` is the single node command the tool routes input through (`node.invoke` with `command: "computer.act"`). It is:

- **Dangerous by default**: listed in the built-in dangerous node commands and excluded from the runtime allowlist until explicitly armed. macOS, Windows, and Linux desktop nodes may still declare it at pairing so the surface is approved once.
- **Capability-based**: the tool requires a connected node to advertise both `computer.act` and `screen.snapshot`. The bundled macOS app is currently the only shipped fulfiller; Windows/Linux platform-app fulfillers are still to come.

Reads reuse `screen.snapshot`; there is no second capture path. See [Camera and screen nodes](/nodes/camera) for the shared capture command.

## Enable and arm

1. For the current macOS fulfiller, enable **Settings → Allow Computer Control**. Then open **Settings → Permissions** and grant **Accessibility** and **Screen Recording** in macOS System Settings.
2. Approve the pairing update on the gateway (a new command forces re-pairing).
3. Expose the tool to the vision-capable agent. For the default `coding` profile:

   ```json5
   {
     tools: {
       alsoAllow: ["computer"],
       // Sandboxed agents need this second gate too:
       sandbox: { tools: { alsoAllow: ["computer"] } },
     },
   }
   ```

4. Arm `computer.act` for a bounded window. The `phone-control` plugin exposes a `computer` group:

   ```text
   /phone arm computer 30m
   /phone status
   /phone disarm
   ```

   Arming requires `operator.admin` (or the owner) and auto-expires. The legacy `/phone arm all` group intentionally excludes desktop control; use the explicit `computer` group. Arming only toggles what the gateway may invoke; the node app still enforces its platform-specific settings and OS permissions, including **Allow Computer Control**, Accessibility, and Screen Recording on macOS.

For persistent authorization, add `computer.act` to `gateway.nodes.allowCommands` **and remove it from** `gateway.nodes.denyCommands`; the deny list wins. Persistent authorization does not auto-expire. Entries already present before `/phone arm` remain after `/phone disarm`; do not convert a temporary grant to persistent while it is armed.

Authorization is deliberately split between enabling and use. Arming or
persistently configuring `computer.act` requires administrative authority.
Once armed, an authenticated operator with `operator.write` can invoke
`computer.act` through `node.invoke` until the grant expires or is disarmed;
there is no per-action admin check. Approving a node that declares
`computer.act` only records the surface so it can be armed later and does not
enable invocation by itself.

## Safety

- Before authorization, every layer (tool policy, gateway command policy, node-app setting, and platform permissions) must agree. For the current macOS fulfiller, that includes **Allow Computer Control**, Accessibility, and Screen Recording. Once armed, actions execute without a per-action confirmation until expiry or `/phone disarm`.
- Text input is posted one grapheme at a time. Cancellation, disconnect, pause, disable, or endpoint replacement stops it before the next grapheme instead of letting the stale remainder continue.
- Screenshots are model-only and never auto-sent to chat (issue [#44759](https://github.com/openclaw/openclaw/issues/44759)).
- Treat screen content as untrusted; it can carry prompt injection.

## Relationship to other desktop-control paths

This is the agent-driven path. See [Peekaboo bridge](/platforms/mac/peekaboo) for how it relates to the PeekabooBridge host, Codex Computer Use, and the direct `cua-driver` MCP.
