---
summary: "Provider-specific troubleshooting shortcuts (Discord/Telegram/WhatsApp)"
read_when:
  - A provider connects but messages don’t flow
  - Investigating provider misconfiguration (intents, permissions, privacy mode)
---
# Provider troubleshooting

Start with:

```bash
clawdbot doctor
clawdbot providers status --probe
```

`providers status --probe` prints warnings when it can detect common provider misconfigurations, and includes small live checks (credentials, some permissions/membership).

## Providers
- Discord: [/providers/discord#troubleshooting](/providers/discord#troubleshooting)
- Telegram: [/providers/telegram#troubleshooting](/providers/telegram#troubleshooting)
- WhatsApp: [/providers/whatsapp#troubleshooting-quick](/providers/whatsapp#troubleshooting-quick)

