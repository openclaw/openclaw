---
title: VK
sidebarTitle: VK
---

# VK

OpenClaw can connect to VK with a community access token and the VK Long Poll API.

## Status

This initial integration is focused on direct messages to the group bot.

## Setup

1. Create or open a VK group.
2. Enable the Long Poll API for the group.
3. Create a community access token with messaging permissions.
4. Configure VK in OpenClaw with `openclaw channels add vk` or the onboarding flow.

You can also use `VK_GROUP_TOKEN` for the default account.

## Notes

- `allowFrom` entries should use numeric VK user ids.
- Group-chat inbound handling is not enabled in this first version.
- Outbound sends target VK `peer_id` values.
