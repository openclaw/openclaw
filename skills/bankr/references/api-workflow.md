# Bankr API Workflow Reference

Understanding the asynchronous job pattern for Bankr API operations.

**Source**: [Agent API Reference](https://www.notion.so/Agent-API-2e18e0f9661f80cb83ccfc046f8872e3)

## Core Pattern: Submit-Poll-Complete

All Bankr operations follow this pattern:

```
1. SUBMIT  → Send prompt, get job ID
2. POLL    → Check status every 2s
3. COMPLETE → Process results
```

## API Endpoints

### POST /agent/prompt
Submit a natural language prompt to start a job.

**Request:**
```bash
curl -X POST "https://api.bankr.bot/agent/prompt" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is my ETH balance?"}'
```

**Request Body:**
- **prompt** (string, required): The prompt to send to the AI agent (max 10,000 characters)

**Response (202 Accepted):**
```json
{
  "success": true,
  "jobId": "job_abc123",
  "status": "pending",
  "message": "Job submitted successfully"
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `Invalid request` or `Prompt too long` | Bad input or exceeds 10,000 chars |
| 401 | `Authentication required` | Missing or invalid API key |
| 403 | `Agent API access not enabled` | API key lacks agent access |

### GET /agent/job/{jobId}
Check job status and results.

**Request:**
```bash
curl -X GET "https://api.bankr.bot/agent/job/job_abc123" \
  -H "X-API-Key: YOUR_API_KEY"
```

**Response (200 OK):**
```json
{
  "success": true,
  "jobId": "job_abc123",
  "status": "completed",
  "prompt": "What is my ETH balance?",
  "response": "You have 0.5 ETH worth approximately $1,825.",
  "richData": [],
  "statusUpdates": [
    {"message": "Checking balances...", "timestamp": "2025-01-26T10:00:00Z"},
    {"message": "Calculating USD values...", "timestamp": "2025-01-26T10:00:02Z"}
  ],
  "createdAt": "2025-01-26T10:00:00Z",
  "completedAt": "2025-01-26T10:00:03Z",
  "processingTime": 3000
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `Job ID required` | Missing job ID in path |
| 401 | `Authentication required` | Missing or invalid API key |
| 404 | `Job not found` | Job ID doesn't exist or doesn't belong to you |

### POST /agent/job/{jobId}/cancel
Cancel a pending or processing job. Cancel requests are idempotent — cancelling an already-cancelled job returns success.

**Request:**
```bash
curl -X POST "https://api.bankr.bot/agent/job/job_abc123/cancel" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json"
```

**Response (200 OK):**
```json
{
  "success": true,
  "jobId": "job_abc123",
  "status": "cancelled",
  "prompt": "Swap 0.1 ETH for USDC",
  "createdAt": "2025-01-26T10:00:00Z",
  "cancelledAt": "2025-01-26T10:00:05Z"
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `Job ID required`, `Job already completed`, or `Job already failed` | Invalid state for cancellation |
| 401 | `Authentication required` | Missing or invalid API key |
| 404 | `Job not found` | Job ID doesn't exist or doesn't belong to you |

## Job Status States

| Status | Description | Action |
|--------|-------------|--------|
| `pending` | Job queued, not yet started | Keep polling |
| `processing` | Job is being processed | Keep polling, show updates |
| `completed` | Job finished successfully | Read response and richData |
| `failed` | Job encountered an error | Check error field |
| `cancelled` | Job was cancelled | No further action |

## Response Fields

### Standard Fields
- **success**: Boolean, true if request succeeded
- **jobId**: Unique job identifier
- **status**: Current job status (`pending`, `processing`, `completed`, `failed`, `cancelled`)
- **prompt**: Original user prompt
- **createdAt**: ISO 8601 timestamp

### Success Fields (status=completed)
- **response**: Natural language response text
- **richData**: Array of structured data objects (see Rich Data below)
- **completedAt**: When job finished (ISO 8601)
- **processingTime**: Duration in milliseconds

### Progress Fields (status=processing)
- **statusUpdates**: Array of progress messages (`{message, timestamp}`)
- **startedAt**: When processing began (ISO 8601)
- **cancellable**: Boolean, whether the job can still be cancelled

### Error Fields (status=failed)
- **error**: Error message
- **completedAt**: When failure occurred (ISO 8601)

### Cancelled Fields (status=cancelled)
- **cancelledAt**: When the job was cancelled (ISO 8601)

## Rich Data Objects

Completed jobs may include a `richData` array containing structured data (e.g., token info, price quotes, charts). Each entry has:

```typescript
type RichData = {
  type?: string;          // e.g., "token_info", "price_quote"
  [key: string]: unknown; // Additional structured data
};
```

The exact shape depends on the operation performed. The `response` field always contains a human-readable text summary regardless of what `richData` contains.

## Polling Strategy

### Timing
- **Interval**: 2 seconds between requests
- **Typical duration**: 30 seconds to 2 minutes
- **Maximum**: 5 minutes (then suggest cancellation)

### Example Polling Loop
```bash
#!/bin/bash
JOB_ID="job_abc123"
MAX_ATTEMPTS=150  # 5 minutes

for i in $(seq 1 $MAX_ATTEMPTS); do
    sleep 2
    STATUS=$(curl -s "https://api.bankr.bot/agent/job/$JOB_ID" \
        -H "X-API-Key: $API_KEY" | jq -r '.status')

    case "$STATUS" in
        completed|failed|cancelled)
            break
            ;;
        *)
            echo "Polling... ($i/$MAX_ATTEMPTS)"
            ;;
    esac
done
```

## Status Update Handling

**Track what you've shown:**
```bash
LAST_UPDATE_COUNT=0

while true; do
    RESULT=$(get_job_status "$JOB_ID")
    CURRENT_COUNT=$(echo "$RESULT" | jq '.statusUpdates | length')

    if [ "$CURRENT_COUNT" -gt "$LAST_UPDATE_COUNT" ]; then
        # Show new updates only
        echo "$RESULT" | jq -r ".statusUpdates[$LAST_UPDATE_COUNT:] | .[].message"
        LAST_UPDATE_COUNT=$CURRENT_COUNT
    fi

    STATUS=$(echo "$RESULT" | jq -r '.status')
    [ "$STATUS" != "pending" ] && [ "$STATUS" != "processing" ] && break

    sleep 2
done
```

## Output Guidelines

### Response Formatting

**Price queries:**
- Clear, direct answer
- Include symbol and price
- Example: "ETH is currently $3,245.67"

**Trading confirmations:**
- Confirm amounts
- Show transaction hash
- Mention gas costs if significant

**Portfolio display:**
- List token amounts and USD values
- Group by chain if multi-chain
- Show total portfolio value

**Market analysis:**
- Summarize key insights
- Highlight important data points
- Keep concise

**Errors:**
- Explain what went wrong clearly
- Suggest next steps
- Avoid technical jargon

## Error Handling

### Authentication Errors (401)
```json
{
  "error": "Authentication required",
  "message": "API key is missing or invalid"
}
```

**Resolution**: Check API key, ensure "Agent API" access is enabled at https://bankr.bot/api

### Forbidden (403)
```json
{
  "error": "Agent API access not enabled",
  "message": "Enable agent access for your API key"
}
```

**Resolution**: Visit https://bankr.bot/api and enable Agent API access on your key

### Rate Limiting (429)
```json
{
  "error": "Rate limit exceeded",
  "message": "Retry after 60 seconds"
}
```

**Resolution**: Wait and retry, implement exponential backoff

### Job Failures
```json
{
  "success": true,
  "status": "failed",
  "error": "Insufficient balance for trade"
}
```

**Resolution**: Check specific error, guide user to fix

## Best Practices

### Submission
1. **Validate input** before submitting
2. **Handle errors** gracefully
3. **Store job ID** for tracking
4. **Show confirmation** to user

### Polling
1. **Use 2-second interval** - Don't poll too fast
2. **Show progress** - Display status updates
3. **Set timeout** - Don't poll forever
4. **Handle network errors** - Retry with backoff

### Completion
1. **Parse response** carefully
2. **Check richData** for structured results
3. **Format output** nicely
4. **Save to history** for reference

### Error Recovery
1. **Identify error type** quickly
2. **Provide clear explanation** to user
3. **Suggest fixes** when possible
4. **Retry** intelligently

## Example Workflows

### Simple Balance Check
```
1. Submit: "What is my ETH balance?"
2. Poll every 2s (completes in ~5s)
3. Show: "You have 0.5 ETH ($1,825)"
```

### Token Swap
```
1. Submit: "Swap 0.1 ETH for USDC"
2. Poll every 2s
   - Update: "Checking balance..."
   - Update: "Finding best route..."
   - Update: "Executing swap..."
3. Complete after ~45s
4. Show: "Swapped 0.1 ETH for 365 USDC"
5. Display transaction hash
```

### Market Research
```
1. Submit: "Analyze ETH price"
2. Poll every 2s
   - Update: "Fetching price data..."
   - Update: "Running technical analysis..."
   - Update: "Analyzing sentiment..."
3. Complete after ~30s
4. Show formatted analysis with key metrics
```

## Security Notes

### API Key
- Never expose in client code
- Use environment variables or config.json
- Rotate periodically
- Monitor usage
- Revoke immediately if leaked at https://bankr.bot/api

### Validation
- Validate user input
- Sanitize prompts
- Check amounts/addresses
- Confirm before critical operations

### Error Messages
- Don't leak sensitive info
- Be helpful but not revealing
- Log internally, show safely
- Guide users constructively

---

**Remember**: The asynchronous pattern allows Bankr to handle complex operations that may take time, while keeping you informed of progress.
