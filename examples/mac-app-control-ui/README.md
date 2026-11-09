# Mac app development in Control UI

Use a paired Mac node for Xcode tools and the Control UI **Desktop** panel for
live viewing and input. Xcode's SwiftUI canvas and iOS Simulator are native Mac
windows, so the Desktop panel shows both at their actual interactive state. Its
fit controls scale the shared Mac display to the available space. This path uses
OpenClaw's existing node and Desktop transport; it needs no preview web server,
Python process, Codex, or Claude.

## Set up the Mac

1. Install Xcode and open the app project. In **Xcode → Settings → Intelligence
   → Model Context Protocol**, allow external agents to use Xcode tools. Xcode
   must remain open for its MCP bridge and preview canvas.
2. Pair an OpenClaw node on the same Mac. In the **node's** `openclaw.json`,
   publish Xcode's MCP bridge and allow device-hosted conversations:

   ```json5
   {
     nodeHost: {
       mcp: { servers: { xcode: { command: "xcrun", args: ["mcpbridge"] } } },
       workerRuns: { enabled: true },
     },
     desktop: { host: { enabled: true } },
   }
   ```

   Restart the CLI node after changing its config. In the OpenClaw macOS app,
   use **Settings → This Mac → Capabilities → Desktop sharing** instead of the
   CLI setting. A same-Mac Gateway can also host the conversation locally.

3. Check that macOS has an RFB listener on loopback with
   `nc -G 2 -z 127.0.0.1 5900`. If absent, enable **System Settings → General →
   Sharing → Screen Sharing**, or repair an existing **Remote Management** setup.
   Remote Management takes control of the Screen Sharing switch and requires
   **Observe** and **Control** permission for the account. OpenClaw's Desktop
   sharing switch does not start either macOS service. The Control UI asks for
   the Mac account credentials when it first connects; do not put them in
   scripts or agent prompts.

## Develop and view

Confirm that the Mac node is connected and Xcode tools are published. For
example, list Xcode windows from the Mac using the normal OpenClaw CLI profile:

```bash
openclaw nodes invoke --node 'My Mac' --command mcp.tools.call.v1 \
  --params '{"server":"xcode","tool":"XcodeListWindows","arguments":{}}' --json
```

Open a conversation hosted on that Mac node. Any model available to OpenClaw
can use the published Xcode tools to edit, build, inspect issues, and test.
Accept Xcode's connection prompt for this node. In Control UI, select the paired
Mac in the Desktop picker, or use the Desktop tab in a device-hosted
conversation. Select **Fit height** for a tall iPhone view, **Fit** for the full
Mac display, and **Take Control** to send pointer and keyboard input. Fit height
scales the whole display; it does not isolate the Simulator window. Full
screen gives the Simulator more room.

For a macOS SwiftUI app, keep Xcode's canvas visible and use its `#Preview`.
For an iOS app, boot a device in Xcode or Simulator and run the app there. The
same Desktop panel shows the Simulator window; clicks and typing reach the
simulated app through macOS. `xcrun simctl list devices booted` identifies the
active device for build and test scripts. The agent's computer tool can inspect
and operate the Mac separately when configured; human Desktop control remains
in the viewer.

If the Gateway is on another machine, host the conversation on the Mac node.
The node relays Desktop bytes to the Gateway over its authenticated outbound
connection. A dedicated Mac VM gives a focused app workspace without exposing
the operator's daily desktop. The current Desktop transport shares the **whole
Mac display**, not an isolated Simulator window; use a dedicated VM when that
boundary matters.

See [node-hosted MCP](https://docs.openclaw.ai/nodes/mcp-and-skills),
[session hosting](https://docs.openclaw.ai/nodes/session-hosting),
[Desktop sharing](https://docs.openclaw.ai/gateway/config-browser-ui-desktop#paired-node-desktops),
and [Apple's Simulator controls](https://developer.apple.com/documentation/xcode/interacting-with-your-app-in-the-ios-or-ipados-simulator).
