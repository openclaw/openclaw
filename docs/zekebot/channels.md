---
summary: "How ZekeBot uses OpenClaw channels while keeping Zeke governance server-side."
read_when:
  - Planning a ZekeBot communication surface
  - Checking channel and profile boundaries
title: "ZekeBot channels"
---

# ZekeBot Channels

ZekeBot keeps OpenClaw channel support. A ZekeBot runtime can use WebChat, Claw Messenger, or other configured OpenClaw channels as the user-facing transport.

The channel does not grant Zeke authority by itself. Tool authority comes from the active profile and the ZekeFlow token bound to that runtime.

## Channel rule

Treat the channel as transport, not identity. ZekeFlow derives caller and entity from trusted server-side configuration, not from text the model sends in a tool argument.

## Current posture

Sprout and Rambo run as internal Zeke-owned runtimes. Future tenant/client deployments should start from the `external-client` profile until an approved brief grants a narrower custom catalog.

## Operational checks

When adding a channel, verify:

- the runtime uses the intended profile,
- the tool catalog matches that profile,
- channel-specific secrets are not visible in tool arguments or logs,
- denied tools remain absent from the model-facing catalog.
