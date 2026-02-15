# Google Antigravity Auth (OpenClaw plugin)

OAuth provider plugin for **Google Antigravity** (Cloud Code Assist).

## Account safety caution

- This plugin is an unofficial integration and is not endorsed by Google.
- Some users have reported account restrictions or suspensions after using third-party Antigravity OAuth clients.
- Use caution, review the applicable Google terms, and avoid using a mission-critical account.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable google-antigravity-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
openclaw models auth login --provider google-antigravity --set-default
```

## Notes

- Antigravity uses Google Cloud project quotas.
- If requests fail, ensure Gemini for Google Cloud is enabled.
