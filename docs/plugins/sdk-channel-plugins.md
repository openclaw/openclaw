---
title: "Channel Plugin SDK"
sidebarTitle: "Channel Plugins"
summary: "Contracts and helpers for native messaging channel plugins, including actions, routing, pairing, and setup"
read_when:
  - You are building a native channel plugin
  - You need to implement the shared `message` tool for a channel
  - You need pairing, setup, or routing helpers for a channel
---

# Channel Plugin SDK

Channel plugins use `defineChannelPluginEntry(...)` from
`openclaw/plugin-sdk/core` and implement the `ChannelPlugin` contract.

## Minimal channel entry

```ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { exampleChannelPlugin } from "./src/channel.js";
import { setExampleRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "example-channel",
  name: "Example Channel",
  description: "Example native channel plugin",
  plugin: exampleChannelPlugin,
  setRuntime: setExampleRuntime,
});
```

## `ChannelPlugin` shape

Important sections of the contract:

- `meta`: docs, labels, and picker metadata
- `capabilities`: replies, polls, reactions, threads, media, and chat types
- `config` and `configSchema`: account resolution and config parsing
- `setup` and `setupWizard`: onboarding/setup flow
- `security`: DM policy and allowlist behavior
- `messaging`: target parsing and outbound session routing
- `actions`: shared `message` tool discovery and execution
- `pairing`, `threading`, `status`, `lifecycle`, `groups`, `directory`

For pure types, import from `openclaw/plugin-sdk/channel-contract`.

## Shared `message` tool

Channel plugins own their channel-specific part of the shared `message` tool
through `ChannelMessageActionAdapter`.

```ts
import { Type } from "@sinclair/typebox";
import { createMessageToolButtonsSchema } from "openclaw/plugin-sdk/channel-actions";

export const exampleActions = {
  describeMessageTool() {
    return {
      actions: ["send", "edit"],
      capabilities: ["buttons"],
      schema: {
        visibility: "current-channel",
        properties: {
          buttons: createMessageToolButtonsSchema(),
          threadId: Type.String(),
        },
      },
    };
  },
  async handleAction(ctx) {
    if (ctx.action === "send") {
      return {
        content: [{ type: "text", text: `send to ${String(ctx.params.to)}` }],
      };
    }

    return {
      content: [{ type: "text", text: `unsupported action: ${ctx.action}` }],
    };
  },
};
```

Key types:

- `ChannelMessageActionAdapter`
- `ChannelMessageActionContext`
- `ChannelMessageActionDiscoveryContext`
- `ChannelMessageToolDiscovery`

## Outbound routing helpers

When a channel plugin needs custom outbound routing, implement
`messaging.resolveOutboundSessionRoute(...)`.

Use `buildChannelOutboundSessionRoute(...)` from `plugin-sdk/core` to return the
standard route payload:

```ts
import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/core";

const messaging = {
  resolveOutboundSessionRoute({ cfg, agentId, accountId, target }) {
    return buildChannelOutboundSessionRoute({
      cfg,
      agentId,
      channel: "example-channel",
      accountId,
      peer: { kind: "direct", id: target },
      chatType: "direct",
      from: accountId ?? "default",
      to: target,
    });
  },
};
```

## Pairing helpers

Use `plugin-sdk/channel-pairing` for DM approval flows:

```ts
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";

const pairing = createChannelPairingController({
  core: runtime,
  channel: "example-channel",
  accountId: "default",
});

const result = pairing.issueChallenge({
  agentId: "assistant",
  requesterId: "user-123",
});
```

That surface also gives you scoped access to pairing storage helpers such as
allowlist reads and request upserts.

## Channel setup helpers

Use:

- `plugin-sdk/channel-setup` for optional or installable channels
- `plugin-sdk/setup` for setup adapters, DM policy, and allowlist prompts
- `plugin-sdk/webhook-ingress` for plugin-owned webhook routes

## Channel plugin guidance

- Keep transport-specific execution inside the channel package.
- Use `channel-contract` types in tests and local helpers.
- Keep `describeMessageTool(...)` and `handleAction(...)` aligned.
- Keep session routing in `messaging`, not in ad-hoc command handlers.
- Prefer focused subpaths over broad runtime coupling.

## Related

- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Entry Points](/plugins/sdk-entrypoints)
- [Plugin Setup](/plugins/sdk-setup)
- [Plugin Internals](/plugins/architecture)
