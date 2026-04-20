# Reply in Slack

A skill to reliably send a threaded reply in Slack, bypassing the default gateway reply handler which appears to be buggy. It reads the channel and thread from the inbound context and uses the `message` tool to ensure delivery.

This is a workaround until the core gateway logic is fixed.
