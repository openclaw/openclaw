# Baidu API Key Setup Guide (OpenClaw)

## BAIDU_API_KEY Not Configured

When the `BAIDU_API_KEY` environment variable is not set, follow these steps:

### 1. Get API Key

Visit: **https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey**

- Log in to your Baidu Cloud account
- Create an application or view existing API keys
- Copy your **API Key** (only API Key is needed)

### 2. Configure OpenClaw

Edit the OpenClaw configuration file: `~/.openclaw/openclaw.json`

Add or merge the following structure:

```json
{
  "skills": {
    "entries": {
      "baidu-search": {
        "env": {
          "BAIDU_API_KEY": "your_actual_api_key_here"
        }
      }
    }
  }
}
```

Replace `"your_actual_api_key_here"` with your actual API key.

### 3. Verify Configuration

```bash
# Check JSON format
cat ~/.openclaw/openclaw.json | python -m json.tool
```

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

### 5. Test

```bash
cd ~/.openclaw/workspace/skills/baidu-search
python3 scripts/search.py '{"query": "test search"}'
```

## Troubleshooting

- Ensure `~/.openclaw/openclaw.json` exists with correct JSON format
- Confirm API key is valid and Baidu AI Search service is activated
- Check account balance on Baidu Cloud
- Restart OpenClaw after configuration changes

**Recommended**: Use OpenClaw configuration file for centralized management
