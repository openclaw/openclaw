---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Qwen OAuth (free tier) in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Qwen with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want free-tier OAuth access to Qwen Coder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Qwen"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Qwen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Qwen provides a free-tier OAuth flow for Qwen Coder and Qwen Vision models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(2,000 requests/day, subject to Qwen rate limits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable the plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins enable qwen-portal-auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the Gateway after enabling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authenticate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login --provider qwen-portal --set-default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This runs the Qwen device-code OAuth flow and writes a provider entry to your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`models.json` (plus a `qwen` alias for quick switching).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `qwen-portal/coder-model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `qwen-portal/vision-model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Switch models with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set qwen-portal/coder-model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reuse Qwen Code CLI login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you already logged in with the Qwen Code CLI, OpenClaw will sync credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
from `~/.qwen/oauth_creds.json` when it loads the auth store. You still need a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`models.providers.qwen-portal` entry (use the login command above to create one).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tokens auto-refresh; re-run the login command if refresh fails or access is revoked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default base URL: `https://portal.qwen.ai/v1` (override with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `models.providers.qwen-portal.baseUrl` if Qwen provides a different endpoint).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Model providers](/concepts/model-providers) for provider-wide rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
