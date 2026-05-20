---
name: earnings
description: Fetch upcoming earnings from the Gesahni bridge.
command-dispatch: tool
command-tool: gesahni_earnings_upcoming_get
command-arg-mode: raw
---

# Earnings

Routes `/earnings` to the read-only `gesahni_earnings_upcoming_get` tool.
The bridge tool defaults to a 14-day lookahead when no explicit `days` is provided.
