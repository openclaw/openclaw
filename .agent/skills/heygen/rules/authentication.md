---
name: authentication
description: API key setup, X-Api-Key header, and authentication patterns for HeyGen
metadata:
  tags: authentication, api-key, headers, security
---

# HeyGen Authentication

All HeyGen API requests require authentication using an API key passed in the `X-Api-Key` header.

## Getting Your API Key

1. Log in to your HeyGen account at https://app.heygen.com
2. Navigate to Settings > API
3. Copy your API key

## Environment Setup

Store your API key securely as an environment variable:

```bash
export HEYGEN_API_KEY="your-api-key-here"
```

For `.env` files:

```
HEYGEN_API_KEY=your-api-key-here
```

## Making Authenticated Requests

### curl

```bash
curl -X GET "https://api.heygen.com/v2/avatars" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript/JavaScript (fetch)

```typescript
const response = await fetch("https://api.heygen.com/v2/avatars", {
  headers: {
    "X-Api-Key": process.env.HEYGEN_API_KEY!,
  },
});
const { data } = await response.json();
```

### TypeScript/JavaScript (axios)

```typescript
import axios from "axios";

const client = axios.create({
  baseURL: "https://api.heygen.com",
  headers: {
    "X-Api-Key": process.env.HEYGEN_API_KEY,
  },
});

const { data } = await client.get("/v2/avatars");
```

### Python (requests)

```python
import os
import requests

response = requests.get(
    "https://api.heygen.com/v2/avatars",
    headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
)
data = response.json()
```

### Python (httpx)

```python
import os
import httpx

async with httpx.AsyncClient() as client:
    response = await client.get(
        "https://api.heygen.com/v2/avatars",
        headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
    )
    data = response.json()
```

## Creating a Reusable API Client

### TypeScript

```typescript
class HeyGenClient {
  private baseUrl = "https://api.heygen.com";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint);
  }

  post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

// Usage
const client = new HeyGenClient(process.env.HEYGEN_API_KEY!);
const avatars = await client.get("/v2/avatars");
```

## API Response Format

All HeyGen API responses follow this structure:

```typescript
interface ApiResponse<T> {
  error: null | string;
  data: T;
}
```

Successful response example:

```json
{
  "error": null,
  "data": {
    "avatars": [...]
  }
}
```

Error response example:

```json
{
  "error": "Invalid API key",
  "data": null
}
```

## Error Handling

Common authentication errors:

| Status Code | Error | Cause |
|-------------|-------|-------|
| 401 | Invalid API key | API key is missing or incorrect |
| 403 | Forbidden | API key doesn't have required permissions |
| 429 | Rate limit exceeded | Too many requests |

### Handling Errors

```typescript
async function makeRequest(endpoint: string) {
  const response = await fetch(`https://api.heygen.com${endpoint}`, {
    headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
  });

  const json = await response.json();

  if (!response.ok || json.error) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }

  return json.data;
}
```

## Rate Limiting

HeyGen enforces rate limits on API requests:
- Standard rate limits apply per API key
- Some endpoints (like video generation) have stricter limits
- Use exponential backoff when receiving 429 errors

```typescript
async function requestWithRetry(
  fn: () => Promise<Response>,
  maxRetries = 3
): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fn();

    if (response.status === 429) {
      const waitTime = Math.pow(2, i) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      continue;
    }

    return response;
  }

  throw new Error("Max retries exceeded");
}
```

## Security Best Practices

1. **Never expose API keys in client-side code** - Always make API calls from a backend server
2. **Use environment variables** - Don't hardcode API keys in source code
3. **Rotate keys periodically** - Generate new API keys regularly
4. **Monitor usage** - Check your HeyGen dashboard for unusual activity
