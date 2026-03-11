# Revenue Executor Smoke Test

## 1) Prerequisites

Set the required runtime settings either via environment variables or plugin config:

- OPENCLAW_REVENUE_GHL_BASE_URL
- OPENCLAW_REVENUE_GHL_API_KEY
- OPENCLAW_REVENUE_GHL_LOCATION_ID
- OPENCLAW_REVENUE_STRIPE_API_KEY

Optional:

- OPENCLAW_REVENUE_DEFAULT_CURRENCY
- OPENCLAW_REVENUE_STRIPE_SUCCESS_URL

## 2) Hook Acceptance Test

From PowerShell:

```powershell
Set-Location C:\Users\gmone\Downloads\openclaw\extensions\revenue-executor\examples
.\smoke-test.ps1 -BaseUrl "https://YOUR-RAILWAY-URL" -HookToken "$env:OPENCLAW_HOOKS_TOKEN"
```

Expected immediate response:

- HTTP 200
- JSON contains runId

## 3) Tool-Level Test Prompt

Use this message body for /hooks/agent:

```json
{
  "message": "Use execute_revenue_command with command: sell coaching program $47 for John Smith"
}
```

Expected structured tool result includes:

- result.price
- result.contact.contactId
- result.opportunity.opportunityId when successful
- result.payment.url when price > 0

## 4) Callback Test (n8n)

Set plugin config field callbackUrl to your n8n webhook URL.

After execute_revenue_command runs, the plugin will POST the full result JSON to callbackUrl.

## 5) Verify a Specific runId in Railway Logs

```powershell
Set-Location C:\Users\gmone\Downloads\openclaw\extensions\revenue-executor\examples
.\verify-run-log.ps1 -RunId "c16a66bb-dd88-474a-bc2c-35a9209193e0" -Since "24h"
```

If no exact runId match appears, the script also scans for revenue-related markers:

- execute_revenue_command
- ghl
- stripe
- callback
- hooks/agent
