# Glitchward Shield for OpenClaw

Protect your OpenClaw agents from prompt injection attacks with Glitchward Shield.

## Features

- **Real-time prompt scanning** - Analyzes incoming messages before they reach the LLM
- **Configurable thresholds** - Set custom warning levels via config
- **Pattern detection** - Identifies known injection techniques
- **Security context injection** - Warns the LLM about risky prompts
- **Dashboard integration** - View detailed reports at glitchward.com

## Installation

The Glitchward Shield extension is included with OpenClaw. To enable it:

```bash
openclaw plugins enable glitchward-shield
openclaw connect glitchward-shield
```

You'll be prompted for:

- Your Glitchward Shield API URL (default: https://glitchward.com/api/shield)
- Your API token (get one at https://glitchward.com/shield)

## Configuration

After setup, configure Shield thresholds in your OpenClaw config:

```bash
openclaw config set plugins.glitchward-shield.apiToken "your-token"
openclaw config set plugins.glitchward-shield.blockThreshold 0.8
openclaw config set plugins.glitchward-shield.warnThreshold 0.5
```

### Configuration Options

| Option           | Type    | Default                             | Description                           |
| ---------------- | ------- | ----------------------------------- | ------------------------------------- |
| `apiUrl`         | string  | `https://glitchward.com/api/shield` | Shield API endpoint                   |
| `apiToken`       | string  | -                                   | Your Shield API token                 |
| `blockThreshold` | number  | 0.8                                 | Risk score to inject security warning |
| `warnThreshold`  | number  | 0.5                                 | Risk score to log warnings (0-1)      |
| `scanIncoming`   | boolean | true                                | Scan incoming messages                |

## Usage

Once configured, Shield automatically protects your OpenClaw instance:

### Check Status

```
/shield
```

Shows current Shield configuration and status.

### Run a Test

```
/shield test
```

Runs a test scan with a known injection pattern to verify Shield is working.

## How It Works

1. **Message Received** - When OpenClaw receives a message, Shield scans it for injection patterns
2. **Risk Assessment** - The Shield API returns a risk score (0-1) and detected patterns
3. **Action** - Based on thresholds:
   - Risk >= block threshold: Security warning injected into LLM context
   - Risk >= warn threshold: Warning logged
   - Risk < warn threshold: Message passes normally

**Note:** Shield injects security context to warn the LLM about risky prompts. It does not hard-block message delivery, as the available hooks don't support cancellation at the agent level.

### Detection Categories

Shield detects various prompt injection techniques:

- **Direct Injection** - "Ignore previous instructions"
- **Indirect Injection** - Hidden instructions in data
- **Jailbreak Attempts** - Roleplay-based bypasses
- **Data Exfiltration** - Attempts to extract system prompts
- **Command Injection** - Malicious tool/command usage

## API

Shield uses the Glitchward Shield API:

```
POST /api/shield/validate
X-Shield-Token: <token>
Content-Type: application/json

{
  "prompt": "message to scan"
}
```

Response:

```json
{
  "safe": false,
  "blocked": true,
  "risk_score": 0.85,
  "matches": [
    {
      "pattern": "ignore_instructions",
      "category": "direct_injection",
      "severity": "high"
    }
  ]
}
```

## Dashboard

View detailed analytics and configure advanced settings at:
https://glitchward.com/shield

## Support

- Documentation: https://docs.glitchward.com/shield
- Issues: https://github.com/glitchward/shield/issues
- Email: support@glitchward.com

## License

MIT License - See LICENSE file for details.
