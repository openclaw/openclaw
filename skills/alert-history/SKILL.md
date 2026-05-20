---
name: alert-history
description: Fetch alert delivery history from the Gesahni bridge.
command-dispatch: tool
command-tool: gesahni_alert_deliveries_get
command-arg-mode: raw
---

# Alert History

Routes `/alert-history <ALERT_ID>` to the read-only `gesahni_alert_deliveries_get` tool.
