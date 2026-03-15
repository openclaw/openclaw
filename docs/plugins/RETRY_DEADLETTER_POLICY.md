# Retry + Dead-letter Policy (v1)

## Retry
- Bounded retries only (no infinite loops)
- Explicit retry count + backoff

## Dead-letter
- Failed items after max retries move to dead-letter queue
- Must include failure reason + next operator action
