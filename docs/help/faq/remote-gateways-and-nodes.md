---
summary: "Command propagation, Tailscale setups, multi-device nodes, and applying config remotely"
title: "Remote gateways and nodes"
read_when:
  - You run the Gateway on a VPS or another machine
  - You are adding a node or wiring Tailscale
---

## Remote gateways and nodes

<AccordionGroup>
  <Accordion title="How do commands propagate between Telegram, the gateway, and nodes?">
    Telegram messages are handled by the **gateway**, which runs the agent and only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

    Telegram -> Gateway -> Agent -> `node.*` -> Node -> Gateway -> Telegram

    Nodes do not see inbound provider traffic; they only receive node RPC calls.

  </Accordion>

  <Accordion title="How can my agent access my computer if the Gateway is hosted remotely?">
    Pair your computer as a **node**. The Gateway runs elsewhere but can call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

    1. Run the Gateway on the always-on host (VPS/home server).
    2. Put the Gateway host and your computer on the same tailnet.
    3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
    4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet) so it registers as a node.
    5. Approve the node:
       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

    Security reminder: pairing a macOS node allows `system.run` on that machine. Only pair devices you trust; review [Security](/gateway/security).

    Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

  </Accordion>

  <Accordion title="Tailscale is connected but I get no replies. What now?">
    Check the basics:

    ```bash
    openclaw gateway status
    openclaw status
    openclaw channels status
    ```

    Then verify auth and routing: if you use Tailscale Serve, confirm `gateway.auth.allowTailscale` is set correctly; if you connect via SSH tunnel, confirm the tunnel is up and points at the right port; confirm your DM/group allowlists include your account.

    Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

  </Accordion>

  <Accordion title="Can two OpenClaw instances talk to each other (local + VPS)?">
    Yes, though there is no built-in bot-to-bot bridge.

    **Simplest**: use a normal chat channel both bots can access (Slack/Telegram/WhatsApp). Have Bot A message Bot B, then let Bot B reply as usual.

    **CLI bridge (generic)**: run a script that calls the other Gateway with `openclaw agent --message ... --deliver`, targeting a chat where the other bot listens. If one bot is on a remote VPS, point your CLI at that remote Gateway via SSH/Tailscale (see [Remote access](/gateway/remote)):

    ```bash
    openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
    ```

    Add a guardrail so the two bots do not loop endlessly (mention-only, channel allowlists, or a "do not reply to bot messages" rule).

    Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

  </Accordion>

  <Accordion title="Do I need separate VPSes for multiple agents?">
    No. One Gateway hosts multiple agents, each with its own workspace, model defaults, and routing - this is the normal setup and much cheaper/simpler than one VPS per agent. Use separate VPSes only for hard isolation (security boundaries) or very different configs you do not want to share.
  </Accordion>

  <Accordion title="Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?">
    Yes: nodes are the first-class way to reach your laptop from a remote Gateway and unlock more than shell access. The Gateway runs on macOS, Linux, and Windows (native or WSL2) and is lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common setup is an always-on host plus your laptop as a node.

    - **No inbound SSH required** - nodes connect out to the Gateway WebSocket via device pairing.
    - **Safer execution controls** - `system.run` is gated by node allowlists/approvals on that laptop.
    - **More device tools** - nodes expose `camera` and `screen` in addition to `system.run`; Macs also expose the widget panel.
    - **Local browser automation** - keep the Gateway on a VPS but run Chrome locally through a node host, or attach to local Chrome via Chrome MCP.

    SSH is fine for ad-hoc shell access; nodes are simpler for ongoing agent workflows and device automation.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Do nodes run a gateway service?">
    No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node hosts and CLI control, see [Node host CLI](/cli/node).

    A full restart is required for `gateway`, `discovery`, and hosted plugin surface changes.

  </Accordion>

  <Accordion title="Is there an API / RPC way to apply config?">
    Yes:

    - `config.schema.lookup`: inspect one config subtree with its shallow schema node, matched UI hint, and immediate child summaries before writing.
    - `config.get`: fetch the current snapshot plus hash.
    - `config.patch`: safe partial update (preferred for most RPC edits); hot-reloads when possible, restarts when required.
    - `config.apply`: validate and replace the full config; hot-reloads when possible, restarts when required.
    - The agent-facing `gateway` runtime tool still refuses to rewrite `tools.exec.ask` / `tools.exec.security`; legacy `tools.bash.*` aliases normalize to the same protected paths.

  </Accordion>

  <Accordion title="Minimal sane config for a first install">
    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
      channels: { whatsapp: { allowFrom: ["+15555550123"] } },
    }
    ```

    Sets your workspace and restricts who can trigger the bot.

  </Accordion>

  <Accordion title="How do I set up Tailscale on a VPS and connect from my Mac?">
    1. **Install + login on the VPS**:
       ```bash
       curl -fsSL https://tailscale.com/install.sh | sh
       sudo tailscale up
       ```
    2. **Install + login on your Mac** using the Tailscale app, same tailnet.
    3. **Enable MagicDNS** in the Tailscale admin console so the VPS has a stable name.
    4. **Use the tailnet hostname**: SSH `ssh user@your-vps.tailnet-xxxx.ts.net`; Gateway WS `ws://your-vps.tailnet-xxxx.ts.net:18789`.

    For the Control UI without SSH, use Tailscale Serve on the VPS:

    ```bash
    openclaw gateway --tailscale serve
    ```

    This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

  </Accordion>

  <Accordion title="How do I connect a Mac node to a remote Gateway (Tailscale Serve)?">
    Serve exposes the **Gateway Control UI + WS**; nodes connect over the same Gateway WS endpoint.

    1. Make sure the VPS and Mac are on the same tailnet.
    2. Use the macOS app in Remote mode (SSH target can be the tailnet hostname) - it tunnels the Gateway port and connects as a node.
    3. Approve the node:
       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Should I install on a second laptop or just add a node?">
    For **local tools only** (screen/camera/exec) on the second laptop, add it as a **node** - one Gateway, no duplicated config. The local tools a node exposes depend on its platform. See [Nodes](/nodes) for the per-platform defaults. Install a second Gateway only for **hard isolation** or two fully separate bots.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>
</AccordionGroup>
