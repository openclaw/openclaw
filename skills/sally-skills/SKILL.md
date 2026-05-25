---
name: sally-skills
description: "Connect Sally Skills, a metered MCP server with six clinical-grade health tools (CGM, wearables, lab OCR, TCM), to an OpenClaw agent over HTTPS."
homepage: https://sally.a1c.io/mcp
metadata:
  {
    "openclaw":
      {
        "emoji": "🩺",
        "category": "Health",
        "transport": "Streamable HTTP",
        "auth": "Bearer sk-sally-…",
        "requires": { "bins": [] },
      },
  }
---

# Sally Skills

[Sally Skills](https://github.com/Sally-A1C/ai-sally-skills) is a metered Model Context Protocol server that exposes the clinical-grade metabolic-health intelligence behind the A1C Insights iOS app to AI agents. One bearer key, six skills, pay-per-call in USD, no subscription.

## Tools the agent gets

| Tool | Cost / call | Returns |
|---|---|---|
| `health_sync` | FREE | 64+ daily biomarkers from wearables, CGM, sleep, vitals, activity, environment. |
| `chat_with_sally` | $0.003 | Preventive-health and Traditional Chinese Medicine Q&A with source citations. |
| `analyze_lab_result` | $0.008 | Parsed lab panel (lipid, HbA1c, CBC, thyroid, hormone, micronutrient) with risk flags grounded in ADA / ACC / ESC guidelines. |
| `food_journal` | $0.004 | Meal photo to macros, glucose-spike prediction, Smart vs Trap categorisation. |
| `health_insights` | $0.003 | Morning, afternoon, or evening readout from the user's last day. |
| `metabolic_overview` | $0.005 | CGM time-in-range, glycemic variability, dawn phenomenon, postprandial response curves. |

## When to Use

Connect Sally Skills when an OpenClaw conversation needs grounded health context:

- The user wants their CGM, sleep, vitals, or activity in the agent's context.
- A lab PDF needs OCR plus clinical interpretation.
- A meal photo needs macro and glucose-spike grading.
- The user asks for a daily readout.
- A 30-day metabolic snapshot is useful.
- A preventive-health or TCM question needs evidence-graded answers.

Do not use Sally Skills for diagnosis or treatment decisions. It returns clinical signals and reference ranges, not medical advice.

## Prerequisites

1. Install **A1C Insights** on iPhone: <https://apps.apple.com/id/app/a1c-insights/id6748399956>
2. Create an account in the app.
3. Sign in to the developer console: <https://console.a1c.io>
4. Open **API Keys**, click **Create new key**, copy the `sk-sally-…` value. It is shown only once.
5. Top up the wallet at <https://console.a1c.io/billing> for paid skills. `health_sync` is permanently free.

## How to Run

OpenClaw with MCP support reads `mcp.json` (or an equivalent config). Add Sally as a remote MCP server:

```json
{
  "mcpServers": {
    "sally": {
      "url": "https://sally.a1c.io/mcp",
      "headers": {
        "Authorization": "Bearer sk-sally-..."
      }
    }
  }
}
```

Restart OpenClaw. The six skills appear as callable tools.

If OpenClaw uses the `mcporter` skill (stdio bridge to remote MCP), you can also connect through that:

```bash
npx mcporter call sally health_sync --header "Authorization:Bearer sk-sally-..."
```

## Quick smoke test

After configuring, verify the connection works:

```bash
curl -sS https://sally.a1c.io/v1/call \
  -H "Authorization: Bearer sk-sally-..." \
  -H "Content-Type: application/json" \
  -d '{"skill":"health_sync","input":{}}' | jq .ok
# → true
```

A `true` response confirms the key resolves to an A1C account and `health_sync` is callable.

## Pitfalls

- **Lab PDFs and meal photos are not persisted by Sally.** They flow agent to gateway to AI service to response, with no S3 or GCS upload. The agent's request cache may be the only copy.
- **`metabolic_overview` requires an active CGM** paired in A1C Insights. Without one it returns `404 not_found` rather than synthesising values.
- **`402 payment_required`** is the wallet-empty signal. Surface a top-up link to <https://console.a1c.io/billing> instead of retrying.
- **The bearer key is the identity.** Sally never accepts a `user_uuid` or `email` in the body. One key per agent or device; sharing one key across humans mixes their data.

## Source

- Public docs and protocol guides: <https://github.com/a1c-ai-agent/sally-skills>
- Gateway source code: <https://github.com/Sally-A1C/ai-sally-skills>
- Developer console: <https://console.a1c.io>
- iOS app (identity source): <https://apps.apple.com/id/app/a1c-insights/id6748399956>
- Contact: ai@sallya1c.com
