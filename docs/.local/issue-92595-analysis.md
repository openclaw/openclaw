# Issue #92595 Analysis: Feishu inbound replies not processed

## Root Cause Analysis

The Feishu bot successfully sends outgoing messages (cron/push) but fails to
process incoming user replies. Gateway logs show no evidence of incoming message
processing from the Feishu channel.

### Key Findings

1. "duplicate plugin id resolved" warning indicates the feishu plugin was found
   from two sources. The config-selected entry wins. This is informational and
   should not block functionality.

2. The `dmPolicy` default is "pairing" - if not explicitly set to "open" (with
   `allowFrom: ["*"]`), inbound DMs from users who haven't been paired will be
   silently dropped.

3. The WebSocket connection for sending messages uses a separate channel from
   event-driven incoming message reception. Outgoing works → WS for send is up.
   Incoming may fail if event subscription is not configured correctly.

4. Feishu uses both WebSocket (for real-time events) and Webhook (for HTTP
   callbacks) modes. The issue is specific to WebSocket mode.

### Recommended Investigation Steps

- Verify `channels.feishu.dmPolicy` is set correctly (not just `plugins.entries`)
- Check Feishu App console event subscription configuration
- Add debug logging at the WebSocket event dispatch point
- Test Webhook mode as an alternative to WebSocket
