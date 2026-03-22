---
title: "Channel Plugin Interface"
sidebarTitle: "Channel Interface"
summary: "Reference for the public ChannelPlugin shape and its most important adapter surfaces"
read_when:
  - You want the public shape of `ChannelPlugin`
  - You need to know which channel fields are required versus optional
  - You are building a channel plugin and want a field-by-field reference
---

# Channel Plugin Interface

This page describes the public `ChannelPlugin` interface used by native channel
plugins.

If you want a step-by-step walkthrough, start with
[Channel Plugins](/plugins/sdk-channel-plugins). This page is the reference for
the interface itself.

## Import

```typescript
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
```

<Warning>
  Additional channel helper subpaths are intentionally not listed here because
  they are expected to move under a channel namespace very soon.
</Warning>

## Required fields

These fields are the public core of a `ChannelPlugin`:

| Field          | What it does                                       |
| -------------- | -------------------------------------------------- |
| `id`           | Stable channel id                                  |
| `meta`         | User-facing metadata for docs, pickers, and setup  |
| `capabilities` | Static flags that describe what the channel can do |
| `config`       | Account listing and account resolution             |

In practice, most real channel plugins also define `setup`, because users need
some way to write account config.

## Minimal shape

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";

type ResolvedAccount = {
  accountId: string | null;
  token: string;
};

export const acmeChatPlugin: ChannelPlugin<ResolvedAccount> = {
  id: "acme-chat",

  meta: {
    id: "acme-chat",
    label: "Acme Chat",
    selectionLabel: "Acme Chat",
    docsPath: "/channels/acme-chat",
    blurb: "Connect OpenClaw to Acme Chat.",
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    reply: true,
    media: true,
  },

  config: {
    listAccountIds(cfg: OpenClawConfig) {
      const section = (cfg.channels as Record<string, unknown>)?.["acme-chat"];
      return section ? ["default"] : [];
    },
    resolveAccount(cfg: OpenClawConfig, accountId?: string | null) {
      const section =
        ((cfg.channels as Record<string, unknown>)?.["acme-chat"] as
          | Record<string, unknown>
          | undefined) ?? {};
      const token = typeof section.token === "string" ? section.token : "";
      if (!token) {
        throw new Error("acme-chat: token is required");
      }
      return {
        accountId: accountId ?? null,
        token,
      };
    },
  },

  setup: {
    applyAccountConfig({ cfg, input }) {
      return {
        ...cfg,
        channels: {
          ...(cfg.channels ?? {}),
          "acme-chat": {
            ...((cfg.channels as Record<string, unknown>)?.["acme-chat"] ?? {}),
            token: input.token,
          },
        },
      };
    },
  },
};
```

## Core sections

### `meta`

`meta` is the user-facing description of the channel.

The most important fields are:

| Field            | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `id`             | Channel id shown in metadata surfaces                |
| `label`          | Human display name                                   |
| `selectionLabel` | Label used in setup pickers                          |
| `docsPath`       | Docs page for this channel                           |
| `blurb`          | Short explanation shown in setup and selection flows |

Other fields like `aliases`, `detailLabel`, `systemImage`, or `order` are
display and UX refinements.

### `capabilities`

`capabilities` tells OpenClaw what the channel supports.

Required:

- `chatTypes`

Common optional flags:

- `media`
- `reply`
- `reactions`
- `threads`
- `polls`
- `nativeCommands`
- `blockStreaming`

These flags shape shared behavior such as the message tool, reply formatting,
and capability diagnostics.

### `config`

`config` is the most important adapter after `meta`.

Required methods:

| Method                            | Meaning                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `listAccountIds(cfg)`             | Return known account ids                                       |
| `resolveAccount(cfg, accountId?)` | Return the resolved account object the rest of the plugin uses |

Common optional methods:

| Method                                 | Use it for                     |
| -------------------------------------- | ------------------------------ |
| `defaultAccountId`                     | Default account selection      |
| `isEnabled` / `isConfigured`           | Channel status and setup flows |
| `describeAccount`                      | Status snapshots               |
| `setAccountEnabled` / `deleteAccount`  | Management flows               |
| `resolveAllowFrom` / `formatAllowFrom` | Shared DM allowlist handling   |

## Common additional sections

Most channel plugins only need a few sections beyond `meta`, `capabilities`,
and `config`.

| Section                   | Use it for                               |
| ------------------------- | ---------------------------------------- |
| `setup`                   | Writing or validating account config     |
| `configSchema`            | Channel config schema and setup UI hints |
| `outbound`                | Sending text, media, and polls           |
| `messaging` / `threading` | Message semantics and session routing    |
| `status`                  | Probes, audits, and diagnostics          |
| `pairing` / `security`    | DM approval, linking, and access policy  |

The channel guide covers the full build path. This page stays focused on the
main public shape authors usually implement directly.

## Interface expectations

Keep these ids aligned:

- `openclaw.plugin.json` `id`
- `package.json` `openclaw.channel.id`
- `defineChannelPluginEntry({ id })`
- `ChannelPlugin.id`

Practical rules:

- `config.resolveAccount(...)` should return a resolved account or throw a
  clear config error.
- Use `defineChannelPluginEntry(...)` for channel plugins instead of
  `definePluginEntry(...)`.
- Prefer `createChatChannelPlugin(...)` and `createChannelPluginBase(...)`
  unless you need full manual control.
- Keep channel-specific behavior inside the plugin adapters instead of pushing
  it back into shared core.

## Related

- [Channel Plugins](/plugins/sdk-channel-plugins) — step-by-step channel walkthrough
- [Plugin Entry Points](/plugins/sdk-entrypoints) — `defineChannelPluginEntry(...)`
- [Plugin Setup and Config](/plugins/sdk-setup) — manifests, setup entries, config schemas
- [Plugin Runtime Helpers](/plugins/sdk-runtime) — `api.runtime` and runtime storage
- [SDK Subpaths](/plugins/sdk-subpaths) — public subpaths
