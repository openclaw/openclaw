# OpenClaw Model Traffic Audit (EXPERIMENTAL)

This adds an **opt-in** audit log that records the inbound/outbound HTTP payloads for the Gateway's:

- OpenAI-compatible endpoint: `POST /v1/chat/completions`
- OpenResponses endpoint: `POST /v1/responses`

It is intended **only for experiments** and debugging. Sensitive data can be redacted.

## Configuration

Add to your `openclaw.json`:

```json
{
  "audit": {
    "modelTraffic": {
      "enabled": true,
      "path": "/data/openclaw/audit/model-traffic-%DATE%.jsonl",
      "redact": {
        "enabled": true,
        "keys": ["authorization", "x-api-key", "api-key", "token"],
        "headVisible": 4,
        "tailVisible": 4,
        "maskChar": "*"
      },
      "granularity": {
        "headers": true,
        "body": true,
        "response": true
      }
    }
  }
}
```

Or use environment variables (legacy, still supported):

```bash
export OPENCLAW_AUDIT_MODEL_TRAFFIC=1
export OPENCLAW_AUDIT_MODEL_TRAFFIC_PATH=/data/openclaw/audit/model-traffic-%DATE%.jsonl
```

Then restart the gateway.

## Redaction

When `redact.enabled` is true (default when audit is enabled):

- Sensitive header values are masked: `Bearer abc123...xyz789` → `Bear****xyz7`
- Sensitive body fields are masked with the same pattern
- Default sensitive keys: `authorization`, `x-api-key`, `api-key`, `x-auth-token`, `token`, `access_token`, `api_key`

## Granularity Controls

Control what gets logged:

| Field      | Description               |
| ---------- | ------------------------- |
| `headers`  | Log HTTP headers          |
| `body`     | Log request/response body |
| `response` | Log response data         |

## Log format

- JSONL (one JSON object per line)
- Two directions:
  - `direction: "in"` for incoming requests
  - `direction: "out"` for outgoing responses / SSE chunks

File is appended to; rotate externally if needed.

## Files

- Core audit logic: `src/gateway/audit-model-traffic.ts`
- Config types: `src/config/types.audit.ts`
- Zod schema: `src/config/zod-schema.ts`
- Gateway hooks:
  - `src/gateway/openai-http.ts`
  - `src/gateway/openresponses-http.ts`

## Quick inspect

```bash
tail -n 50 /data/openclaw/audit/model-traffic.jsonl | jq .
```

Filter only requests:

```bash
jq 'select(.direction=="in")' /data/openclaw/audit/model-traffic.jsonl | head
```

## Notes

- Failures in audit logging never break request handling.
- Config-based settings take precedence over environment variables for `path`.
- Either env var `OPENCLAW_AUDIT_MODEL_TRAFFIC=1` OR config `audit.modelTraffic.enabled: true` can enable audit.
