---
summary: "Community web dashboards and other third-party interfaces for the OpenClaw Gateway"
read_when:
  - You want a community dashboard instead of the built-in Control UI
  - You are building an external web interface for the OpenClaw Gateway
  - You need security guidance before exposing a third-party UI
sidebarTitle: "Third-party UIs"
title: "Third-party UIs"
---

OpenClaw ships the built-in [Control UI](/web/control-ui), but the Gateway protocol also lets community projects build alternate dashboards, event viewers, and operator consoles.

Third-party UIs are separate projects. Review their source, release process, and security model before giving them access to a Gateway token, password, workspace, or public network route.

## Available UIs

<CardGroup cols={2}>
  <Card title="DeepClaw UI" href="https://github.com/c0hm/deepclaw-ui" icon="monitor">
    Community dashboard for live Gateway sessions, event visibility, tool-call inspection, token usage, chat, and file sharing.
  </Card>
</CardGroup>

## Connecting a third-party UI

Most external UIs connect to the Gateway WebSocket and authenticate the same way other Gateway clients do:

- local Gateway: `ws://127.0.0.1:18789`
- TLS Gateway: `wss://<host>:18789`
- optional Control UI base path: set `gateway.controlUi.basePath` only for the built-in static UI route; WebSocket clients should follow the UI project documentation for its Gateway URL setting

Use the least-privileged auth mode that fits your deployment:

- local loopback while testing
- Tailscale Serve or another identity-aware private proxy for remote access
- explicit Gateway token or password only when the UI needs it

See [Web](/web), [Gateway remote access](/gateway/remote), and [Tailscale](/gateway/tailscale) for the supported Gateway network patterns.

## Security checklist

Before running a third-party UI against a real Gateway:

- Keep the Gateway itself protected by Gateway auth, Tailscale, or a trusted private network.
- Do not put a Gateway token or password into a public static site, browser bundle, screenshot, log, or issue report.
- Prefer environment variables, local config files, or server-side secret storage when the UI supports them.
- Rotate any Gateway credential that was pasted into a tool you do not fully control.
- If the UI exposes its own HTTP server, enable its password, TLS, or reverse-proxy auth before exposing it beyond loopback.
- Treat file-sharing and transcript export features as sensitive because they may reveal workspace paths, tool output, prompts, or private conversation history.

## Building your own UI

Use the Gateway WebSocket protocol rather than scraping the built-in Control UI. The Gateway protocol is the stable integration surface for external dashboards and clients.

Relevant references:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol](/gateway/bridge-protocol)
- [Control UI](/web/control-ui)
- [WebChat](/web/webchat)

If your UI is open source and broadly useful, open a docs PR adding it to this page with a short description, repository link, supported auth mode, and any important security notes.
