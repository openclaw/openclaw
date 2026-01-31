# API Reference

## Cursor Background Agents API

Base URL: `https://api.cursor.com/v0`

### Authentication

All requests require a Bearer token:

```
Authorization: Bearer <your-api-key>
```

Get your API key from: https://cursor.com/dashboard?tab=background-agents

---

## Endpoints

### Launch Agent

**POST** `/v0/agents`

Launch a new background agent to work on a task.

#### Request

```typescript
{
  "prompt": {
    "text": string,           // Task instructions
    "images"?: [{             // Optional: visual context
      "data": string,         // Base64 encoded
      "dimension": {
        "width": number,
        "height": number
      }
    }]
  },
  "source": {
    "repository": string,     // GitHub repo URL
    "ref": string            // Branch name
  },
  "webhookUrl"?: string      // Optional: webhook for updates
}
```

#### Response

```typescript
{
  "id": string,              // Agent ID (bc_xxx)
  "status": "PENDING",
  "url"?: string             // Link to Cursor UI
}
```

#### Example

```bash
curl -X POST https://api.cursor.com/v0/agents \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": {
      "text": "Add a README.md with installation instructions"
    },
    "source": {
      "repository": "https://github.com/user/repo",
      "ref": "main"
    }
  }'
```

---

### List Agents

**GET** `/v0/agents`

List all background agents.

#### Response

```typescript
[
  {
    id: string,
    status: "PENDING" | "RUNNING" | "FINISHED" | "ERROR",
    createdAt: string, // ISO 8601 timestamp
  },
];
```

#### Example

```bash
curl https://api.cursor.com/v0/agents \
  -H "Authorization: Bearer $CURSOR_API_KEY"
```

---

### Get Agent Details

**GET** `/v0/agents/:id`

Get details for a specific agent.

#### Response

```typescript
{
  "id": string,
  "status": "PENDING" | "RUNNING" | "FINISHED" | "ERROR",
  "summary"?: string,        // Task summary (when finished)
  "target"?: {
    "branchName"?: string,   // Created branch
    "prUrl"?: string         // Pull request URL
  }
}
```

#### Example

```bash
curl https://api.cursor.com/v0/agents/bc_abc123 \
  -H "Authorization: Bearer $CURSOR_API_KEY"
```

---

### Send Follow-up

**POST** `/v0/agents/:id/messages`

Send a follow-up message to an agent.

#### Request

```typescript
{
  "text": string             // Follow-up instructions
}
```

#### Response

```typescript
{
  "success": boolean
}
```

#### Example

```bash
curl -X POST https://api.cursor.com/v0/agents/bc_abc123/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Also add a LICENSE file"}'
```

---

## Webhooks

### Overview

When you provide a `webhookUrl` when launching an agent, Cursor will send HTTP POST requests to notify you about status changes.

### Event Types

Currently only `statusChange` events are supported.

### Headers

| Header                | Description                                  |
| --------------------- | -------------------------------------------- |
| `X-Webhook-Signature` | HMAC-SHA256 signature: `sha256=<hex_digest>` |
| `X-Webhook-ID`        | Unique delivery ID                           |
| `X-Webhook-Event`     | Event type (`statusChange`)                  |
| `User-Agent`          | `Cursor-Agent-Webhook/1.0`                   |

### Signature Verification

```javascript
const crypto = require("crypto");

function verifyWebhook(secret, rawBody, signature) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return signature === expected;
}
```

### Payload

```typescript
{
  "event": "statusChange",
  "timestamp": string,       // ISO 8601
  "id": string,              // Agent ID
  "status": "PENDING" | "RUNNING" | "FINISHED" | "ERROR",
  "source": {
    "repository": string,
    "ref": string
  },
  "target"?: {               // Present when finished
    "url"?: string,          // Cursor UI link
    "branchName"?: string,   // Created branch
    "prUrl"?: string         // Pull request URL
  },
  "summary"?: string,        // Task summary
  "error"?: string           // Error message (when failed)
}
```

### Example Payloads

**RUNNING**

```json
{
  "event": "statusChange",
  "timestamp": "2024-01-15T10:30:00Z",
  "id": "bc_abc123",
  "status": "RUNNING",
  "source": {
    "repository": "https://github.com/user/repo",
    "ref": "main"
  }
}
```

**FINISHED**

```json
{
  "event": "statusChange",
  "timestamp": "2024-01-15T10:35:00Z",
  "id": "bc_abc123",
  "status": "FINISHED",
  "source": {
    "repository": "https://github.com/user/repo",
    "ref": "main"
  },
  "target": {
    "url": "https://cursor.com/agents?id=bc_abc123",
    "branchName": "cursor/add-readme-xyz",
    "prUrl": "https://github.com/user/repo/pull/42"
  },
  "summary": "Added README.md with installation instructions"
}
```

**ERROR**

```json
{
  "event": "statusChange",
  "timestamp": "2024-01-15T10:32:00Z",
  "id": "bc_abc123",
  "status": "ERROR",
  "source": {
    "repository": "https://github.com/user/repo",
    "ref": "main"
  },
  "error": "Repository not found or access denied"
}
```

---

## OpenClaw Integration API

### Message Format

Users can include special annotations in messages:

| Annotation       | Description         | Example                             |
| ---------------- | ------------------- | ----------------------------------- |
| `@repo:<url>`    | Override repository | `@repo:https://github.com/org/repo` |
| `@branch:<name>` | Override branch     | `@branch:develop`                   |

### Examples

**Basic task**

```
Fix the authentication bug
```

**With repository**

```
@repo:https://github.com/myorg/webapp Fix the login issue
```

**With repository and branch**

```
@repo:https://github.com/myorg/webapp @branch:feature-auth Add OAuth support
```

### Response Format

**Success**

```
✅ Cursor Agent Task Completed

Summary: Fixed null check in authentication flow

Pull Request: https://github.com/myorg/webapp/pull/42
Branch: cursor/fix-auth-abc123

View in Cursor
```

**Error**

```
❌ Cursor Agent Task Failed

Error: Repository not found or access denied

View Details
```

---

## Rate Limits

Cursor API has rate limits (check current limits in Cursor docs):

- Requests per minute
- Concurrent agents
- API calls per day

The integration handles rate limiting with exponential backoff.

---

## Error Codes

| Status | Meaning                         |
| ------ | ------------------------------- |
| 400    | Bad request (invalid payload)   |
| 401    | Unauthorized (invalid API key)  |
| 403    | Forbidden (no access to repo)   |
| 404    | Not found (agent doesn't exist) |
| 429    | Rate limited                    |
| 500    | Server error                    |

---

## SDK Usage

```typescript
import { launchAgentTask, listAgents, getAgentDetails } from "./src/api.js";

// Launch an agent
const result = await launchAgentTask(account, {
  instructions: "Add unit tests",
  repository: "https://github.com/user/repo",
  branch: "main",
  webhookUrl: "https://example.com/webhook",
});

console.log(`Launched: ${result.id}`);

// List all agents
const agents = await listAgents(account);

// Get details
const details = await getAgentDetails(account, "bc_abc123");
```
