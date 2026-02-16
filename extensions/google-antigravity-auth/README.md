# Google Antigravity Auth (SmartAgentNeo plugin)

OAuth provider plugin for **Google Antigravity** (Cloud Code Assist).

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
smart-agent-neo plugins enable google-antigravity-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
smart-agent-neo models auth login --provider google-antigravity --set-default
```

## Notes

- Antigravity uses Google Cloud project quotas.
- If requests fail, ensure Gemini for Google Cloud is enabled.
