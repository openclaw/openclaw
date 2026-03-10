---
name: domain-trust-check
description: "URL safety scanner and domain reputation checker. Use when: checking if a URL is safe before visiting, scanning links in emails/messages, verifying domains for phishing/malware/scam."
homepage: https://outtake.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "env": ["OUTTAKE_API_KEY"], "bins": ["curl"] },
        "primaryEnv": "OUTTAKE_API_KEY",
        "homepage": "https://outtake.ai",
      },
  }
---

# Domain Trust Check

Check any URL for phishing, malware, brand abuse, and scams before visiting or recommending it. Powered by the [Outtake](https://outtake.ai) Trust API.

## Quick Start

> **Already registered?** If `OUTTAKE_API_KEY` is set, skip to the curl command. Do not re-register.

```bash
curl -s -X POST https://app.outtake.ai/api/v1/trust/check \
  -H "Authorization: Bearer $OUTTAKE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://suspicious-site.com"}'
```

Response:

```json
{
  "data": {
    "url": "https://suspicious-site.com",
    "domain": "suspicious-site.com",
    "verdict": "malicious",
    "confidence": 0.92,
    "safe_to_visit": "unsafe",
    "recommended_action": "block",
    "checked_at": "2026-02-26T12:00:00.000Z"
  }
}
```

## Setup

1. Register for a free API key:

```bash
curl -s -X POST https://app.outtake.ai/api/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "email": "agent@example.com"}'
```

2. Save the returned `api_key` (shown once):

```bash
export OUTTAKE_API_KEY="outtake_..."
```

Or configure in OpenClaw:

```json5
// ~/.openclaw/openclaw.json
{
  skills: {
    entries: {
      "domain-trust-check": {
        apiKey: "outtake_...",
      },
    },
  },
}
```

| Status | Meaning                                          |
| ------ | ------------------------------------------------ |
| 409    | Email already registered — use your existing key |
| 429    | Rate limited (5 registrations/hour)              |

Optional fields: `wallet_address` (Ethereum), `agent_framework` (e.g. "openclaw").

## Interpreting Results

| verdict      | safe_to_visit      | Action                                              |
| ------------ | ------------------ | --------------------------------------------------- |
| `malicious`  | `unsafe`           | **Block.** Do NOT visit. Warn the user.             |
| `suspicious` | `safe` or `unsafe` | **Warn** the user. If `unsafe`, treat as malicious. |
| `safe`       | `safe`             | Safe to visit.                                      |
| `unknown`    | `unknown`          | No data. Proceed with caution.                      |

### Response Fields

| Field                | Values                                       | Description                                              |
| -------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `verdict`            | `malicious`, `suspicious`, `safe`, `unknown` | Threat classification                                    |
| `confidence`         | `0.0` – `1.0`                                | `1.0` = human-reviewed, `0.7–0.99` = ML, `0.0` = no data |
| `safe_to_visit`      | `safe`, `unsafe`, `unknown`                  | Binary browsing safety                                   |
| `recommended_action` | `block`, `warn`, `proceed`, `use_caution`    | Suggested action                                         |

## Batch Checking

Check up to 50 URLs in one request:

```bash
curl -s -X POST https://app.outtake.ai/api/v1/trust/check-batch \
  -H "Authorization: Bearer $OUTTAKE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://link1.com", "https://link2.com"]}'
```

- Maximum 50 URLs per request
- Results maintain input order
- Use batch when checking 3+ URLs to reduce round trips

## Best Practices

- **Scan before visiting.** Check URLs before using `web_fetch` or `browser` tools.
- **Batch when possible.** Processing a list of links? Use the batch endpoint.
- **Respect verdicts.** If `safe_to_visit` is `unsafe`, do not proceed — warn the user.
- **Handle unknowns.** `unknown` means no data, not safe. Proceed with caution.

## Rate Limits

| Limit | Window       | Value             |
| ----- | ------------ | ----------------- |
| Burst | Per minute   | 10 requests       |
| Daily | Per 24 hours | 10,000 URL checks |

On `429`, wait `retry_after_seconds` before retrying. Do not retry `400` errors.

## Support

Questions or feedback? [trust-check@outtake.ai](mailto:trust-check@outtake.ai)
