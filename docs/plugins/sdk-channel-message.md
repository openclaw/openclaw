---
summary: "Redirect to /plugins/sdk-channel-outbound"
title: "Channel message API"
---

This page moved to [Channel outbound API](/plugins/sdk-channel-outbound).

`openclaw/plugin-sdk/channel-message` and
`openclaw/plugin-sdk/channel-message-runtime` remain deprecated compatibility
subpaths for older plugins. New channel plugins should use
`openclaw/plugin-sdk/channel-outbound` for message lifecycle, receipt, durable
send, and live preview helpers.

Removal plan: keep these aliases through the external plugin migration window,
then remove them in the next major SDK cleanup after callers have moved to
`channel-outbound`.
