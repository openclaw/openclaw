# Inbox Zero + Operator1 Integration

> Hybrid webhook + API integration between Inbox Zero (open-source email AI assistant) and Operator1 for unified email context and task management.

**Status:** Planning
**Created:** 2026-03-09
**Updated:** 2026-03-10
**Priority:** Future Feature
**Effort:** 2-3 days

---

## Overview

### The Problem

- User has 3+ email accounts (Gmail personal, work, custom domains)
- Email overwhelm — needs AI-powered triage and management
- Wants email context shared with Operator1 for unified memory
- Wants proactive notifications for urgent emails
- Wants ability to query email history for large data requests

### The Solution: Hybrid Webhook + API Bridge

Two complementary integration mechanisms:

| Mechanism   | Use Case                                                    | Direction              |
| ----------- | ----------------------------------------------------------- | ---------------------- |
| **Webhook** | Proactive notifications (new email, urgent, action needed)  | Inbox Zero → Operator1 |
| **API**     | On-demand queries (search emails, fetch history, bulk data) | Operator1 → Inbox Zero |

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Inbox Zero (Self-Hosted or Cloud)                   │
│                                                                      │
│  ┌────────────────┐                    ┌────────────────┐          │
│  │  Email Events  │ ──webhook──►       │  REST API      │          │
│  │  (new, urgent) │                    │  (query, sync) │          │
│  └────────────────┘                    └────────────────┘          │
│         │                                       ▲                   │
└─────────┼───────────────────────────────────────┼───────────────────┘
          │                                       │
          │ POST /webhook                         │ GET /api/emails
          ▼                                       │
┌─────────────────────────────────────────────────┼───────────────────┐
│              Operator1 Bridge Skill                                 │
│                                                                     │
│  ┌────────────────┐                    ┌────────────────┐          │
│  │  Webhook       │                    │  API Client    │          │
│  │  Handler       │                    │  (queries)     │          │
│  └───────┬────────┘                    └───────┬────────┘          │
│          │                                     │                    │
│          └─────────────┬───────────────────────┘                    │
│                        │                                            │
│                        ▼                                            │
│              ┌────────────────┐                                     │
│              │  Gateway RPC   │                                     │
│              │  (agent call)  │                                     │
│              └───────┬────────┘                                     │
└──────────────────────┼──────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       OpenClaw Gateway                                │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                    Operator1 Agent (Main)                        │ │
│  │                                                                  │ │
│  │  Capabilities:                                                   │ │
│  │  - Receive proactive email notifications                        │ │
│  │  - Query email history on demand                                │ │
│  │  - Draft replies                                                │ │
│  │  - Create tasks from emails                                     │ │
│  │  - Notify via Telegram                                          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Inbox Zero Overview

**Repository:** https://github.com/elie222/inbox-zero
**What it is:** Open-source AI email assistant — self-hosted alternative to Fyxer

**Key Features:**

- AI Personal Assistant (organizes inbox, pre-drafts replies)
- Multi-account support (Gmail + Microsoft)
- Reply Zero (track emails needing follow-up)
- Cold Email Blocker
- Email Analytics

**Tech Stack:** Next.js, Tailwind, shadcn/ui, Prisma, Upstash Redis, Google Pub/Sub, Docker

**Current Integration State:**
| Mechanism | Availability | Notes |
|-----------|--------------|-------|
| Google Pub/Sub | ✅ Built-in | For Gmail real-time notifications (internal) |
| Internal event system | ✅ Yes | Used for AI processing |
| External webhooks | ⚠️ Built-in "Call Webhook" action | May be sufficient — verify in Phase 0 before forking |
| Public API | ❌ Not documented | Internal endpoints only |

---

## Architecture

### Hybrid Integration Pattern

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Inbox Zero (Minimal Fork)                          │
│                                                                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                     │
│  │   Gmail    │  │  Outlook   │  │  Custom    │                     │
│  │  Account   │  │  Account   │  │  Account   │                     │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘                     │
│        │               │               │                             │
│        └───────────────┴───────────────┘                             │
│                        │                                              │
│                        ▼                                              │
│           ┌────────────────────────┐                                 │
│           │  Google Pub/Sub /      │                                 │
│           │  Polling Mechanism     │                                 │
│           └───────────┬────────────┘                                 │
│                       │                                               │
│                       ▼                                               │
│           ┌────────────────────────┐                                 │
│           │  Email Processor       │                                 │
│           │  (categorization)      │                                 │
│           └───────────┬────────────┘                                 │
│                       │                                               │
│         ┌─────────────┴─────────────┐                                │
│         ▼                           ▼                                │
│  ┌────────────────┐         ┌────────────────┐                      │
│  │  Webhook       │         │  REST API      │  ← NEW               │
│  │  Emission      │  ← NEW  │  Endpoints     │                      │
│  │  (proactive)   │         │  (on-demand)   │                      │
│  └───────┬────────┘         └───────┬────────┘                      │
│          │                          ▲                                │
└──────────┼──────────────────────────┼────────────────────────────────┘
           │                          │
           │ Webhook POST             │ API GET/POST
           ▼                          │
┌─────────────────────────────────────┼────────────────────────────────┐
│          Operator1 Bridge Skill     │                                │
│                                     │                                │
│  ┌────────────────┐         ┌──────┴───────┐                       │
│  │  Webhook       │         │  API Client  │                       │
│  │  Handler       │         │  (HTTP)      │                       │
│  │                │         │              │                       │
│  │  - Validate    │         │  - Search    │                       │
│  │  - Queue       │         │  - Fetch     │                       │
│  │  - Process     │         │  - Sync      │                       │
│  └───────┬────────┘         └──────┬───────┘                       │
│          │                         │                                │
│          └───────────┬─────────────┘                                │
│                      │                                              │
│                      ▼                                              │
│           ┌────────────────┐                                        │
│           │  Event Queue   │  ← BullMQ/Redis                        │
│           │  (retries)     │                                        │
│           └───────┬────────┘                                        │
│                   │                                                  │
│                   ▼                                                  │
│           ┌────────────────┐                                        │
│           │  Gateway RPC   │                                        │
│           │  (WebSocket)   │                                        │
│           └───────┬────────┘                                        │
└───────────────────┼──────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       OpenClaw Gateway                                │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                    Operator1 Agent (Main)                        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Webhook Integration (Proactive Events)

### Purpose

Receive real-time notifications when important email events occur:

- New email arrives
- Email marked urgent
- Action required detected
- Follow-up reminder triggered

### Webhook Payload Format

> **Note:** HMAC signature must be sent as the `X-Inbox-Zero-Signature` HTTP header (computed over the raw request body), **not** as a field inside the JSON body. Embedding it in the body creates a circular dependency where the body being signed already contains the signature.

```json
{
  "id": "evt_abc123",
  "type": "new_email | urgent_email | action_required | follow_up",
  "timestamp": "2026-03-10T07:00:00Z",
  "data": {
    "emailId": "msg123",
    "accountId": "personal@gmail.com",
    "accountLabel": "Personal",
    "from": "sender@example.com",
    "fromName": "John Doe",
    "subject": "Meeting Tomorrow",
    "snippet": "Hi, can we meet tomorrow at 3pm...",
    "body": "Hi, can we meet tomorrow at 3pm? Let me know what works for you.",
    "labels": ["INBOX", "UNREAD"],
    "threadId": "thread456",
    "category": "urgent | action_required | informational | newsletter"
  }
}
```

HTTP headers sent alongside:

```
X-Inbox-Zero-Signature: sha256=<hmac_of_raw_body>
Content-Type: application/json
```

### Webhook Error Responses

The bridge (or OpenClaw hooks pipeline) should respond to Inbox Zero with standard HTTP status codes so Inbox Zero knows whether to retry:

| Status                    | Meaning                         | When to use                                                                   |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `200 OK`                  | Acknowledged — processing async | Default: always return this once signature is verified; do not wait for agent |
| `401 Unauthorized`        | Bad or missing signature        | Signature mismatch                                                            |
| `429 Too Many Requests`   | Rate limit exceeded             | Per-account rate limit hit                                                    |
| `503 Service Unavailable` | Gateway unavailable             | Circuit breaker open (Option B only)                                          |

> **Best practice:** Return `200 OK` immediately after signature validation and process the event asynchronously. This prevents Inbox Zero from timing out and retrying events that are already being handled.

### Security (HMAC Signing)

**Problem:** Simple string comparison is vulnerable to timing attacks.

**Solution:** HMAC-SHA256 with timing-safe comparison.

```typescript
// inbox-zero/utils/webhook-sign.ts
import crypto from "crypto";

export function signWebhook(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = signWebhook(payload, secret);
  // Timing-safe comparison
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### Replay Attack Protection

**Problem:** Attacker captures webhook and replays it later.

**Solution:** Timestamp validation + nonce.

```typescript
// operator1-bridge/security/replay-protection.ts
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

export async function validateWebhook(event: WebhookEvent): Promise<boolean> {
  // 1. Check timestamp (reject if > 5 minutes old)
  const age = Date.now() - new Date(event.timestamp).getTime();
  if (age > 5 * 60 * 1000) {
    throw new Error("Webhook too old");
  }

  // 2. Check nonce (prevent replay)
  const nonceKey = `webhook:nonce:${event.id}`;
  const exists = await redis.exists(nonceKey);
  if (exists) {
    throw new Error("Webhook already processed");
  }

  // 3. Store nonce with TTL
  await redis.setex(nonceKey, 300, "1"); // 5 min TTL

  return true;
}
```

### Rate Limiting

**Problem:** DoS via webhook flood.

**Solution:** Token bucket per account.

```typescript
// operator1-bridge/security/rate-limiter.ts
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const RATE_LIMIT = 100; // webhooks per minute per account

export async function checkRateLimit(accountId: string): Promise<boolean> {
  const key = `ratelimit:${accountId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, 60); // 1 minute window
  }

  if (count > RATE_LIMIT) {
    throw new Error(`Rate limit exceeded for ${accountId}`);
  }

  return true;
}
```

### Event Queue (Retry + Dead Letter)

**Problem:** Failed webhooks = lost events.

**Solution:** BullMQ queue with exponential backoff + dead letter queue.

```typescript
// operator1-bridge/queue/index.ts
import Queue, { Job } from "bullmq";
import { Redis } from "ioredis";

const connection = new Redis(process.env.REDIS_URL);

export const webhookQueue = new Queue("webhook-events", { connection });

export const deadLetterQueue = new Queue("webhook-dlq", { connection });

// Worker with retry logic
export async function processWebhook(job: Job<WebhookEvent>) {
  try {
    const result = await handleEmailEvent(job.data);
    return result;
  } catch (error) {
    // Retry with exponential backoff
    if (job.attemptsMade < 5) {
      throw error; // BullMQ will retry
    }

    // Max retries reached → dead letter queue
    await deadLetterQueue.add("failed", {
      originalJob: job.data,
      error: error.message,
      failedAt: new Date().toISOString(),
    });

    throw error;
  }
}

// Queue configuration
webhookQueue.add("event", eventData, {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 1000, // 1s, 2s, 4s, 8s, 16s
  },
  removeOnComplete: 100, // Keep last 100 successful
  removeOnFail: 500, // Keep last 500 failed
});
```

### Circuit Breaker

**Problem:** If Gateway is down, every request times out.

**Solution:** Circuit breaker pattern.

```typescript
// operator1-bridge/circuit-breaker.ts
import CircuitBreaker from "opossum";

const gatewayBreaker = new CircuitBreaker(callGatewayRPC, {
  timeout: 30000, // 30s timeout
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 30000, // Try again after 30s
});

gatewayBreaker.on("open", () => {
  console.warn("Circuit breaker OPEN - Gateway unavailable");
});

gatewayBreaker.on("halfOpen", () => {
  console.log("Circuit breaker HALF-OPEN - Testing gateway");
});

gatewayBreaker.on("close", () => {
  console.log("Circuit breaker CLOSED - Gateway healthy");
});

export async function callGatewaySafely(params: GatewayParams) {
  return gatewayBreaker.fire(params);
}
```

---

## Part 2: API Integration (On-Demand Queries)

### Purpose

Allow Operator1 to query Inbox Zero for:

- Email search (find emails from X about Y)
- Email history (last 30 days for account)
- Thread context (full conversation)
- Bulk data sync (initial load)

### API Endpoints (Minimal Fork Addition)

```typescript
// inbox-zero/app/api/operator1/emails/route.ts

import { NextRequest, NextResponse } from "next/server";
import { verifyOperator1Auth } from "@/lib/operator1-auth";
import { prisma } from "@/lib/prisma";

// GET /api/operator1/emails - Search/list emails
export async function GET(request: NextRequest) {
  // Auth check
  if (!verifyOperator1Auth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  const query = searchParams.get("q");
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = parseInt(searchParams.get("offset") || "0");

  let emails;

  if (query) {
    // Search mode
    emails = await prisma.email.findMany({
      where: {
        accountId,
        OR: [
          { subject: { contains: query, mode: "insensitive" } },
          { body: { contains: query, mode: "insensitive" } },
          { from: { contains: query, mode: "insensitive" } },
        ],
      },
      take: limit,
      skip: offset,
      orderBy: { receivedAt: "desc" },
    });
  } else {
    // List mode
    emails = await prisma.email.findMany({
      where: { accountId },
      take: limit,
      skip: offset,
      orderBy: { receivedAt: "desc" },
    });
  }

  return NextResponse.json({ emails });
}

// GET /api/operator1/emails/[id] - Single email with thread
export async function getEmail(request: NextRequest, { params }: { params: { id: string } }) {
  if (!verifyOperator1Auth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = await prisma.email.findUnique({
    where: { id: params.id },
    include: {
      thread: {
        include: {
          emails: {
            orderBy: { receivedAt: "asc" },
          },
        },
      },
    },
  });

  return NextResponse.json({ email });
}

// GET /api/operator1/accounts - List connected accounts
export async function getAccounts(request: NextRequest) {
  if (!verifyOperator1Auth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await prisma.emailAccount.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      provider: true,
    },
  });

  return NextResponse.json({ accounts });
}
```

### How Operator1 Invokes the API

The API client code below handles HTTP communication with Inbox Zero. The agent needs a way to call these functions as tools. Three options, in order of preference:

1. **Dedicated skill with tool definitions (recommended):** Create `skills/inbox-zero/SKILL.md` that describes `searchEmails`, `getEmailThread`, and `getAccounts` as shell-executable commands (e.g., a small `inbox-zero-cli` wrapper). The agent invokes them via its `exec` tool, same pattern as all other skills in this repo.

2. **`exec` with a CLI wrapper:** Write a thin CLI (`inbox-zero-cli search --query "..." --account "..."`) that calls the HTTP API and prints JSON. Reference it from SKILL.md. No bespoke plugin API needed.

3. **Internal plugin (Option B only):** If a standalone bridge service is chosen, expose the functions directly via the bridge's RPC interface and call `dispatchGatewayMethod` — but this requires Option B's full service setup.

> The import `from "openclaw/gateway/call"` in the code below is a **placeholder** — it is not a valid path. For Option A, the API client is called from the CLI wrapper, not from gateway code.

### API Client in Bridge Skill

```typescript
// operator1-bridge/api-client.ts

// NOTE: callGateway import below is a placeholder — see "How Operator1 Invokes the API" above.

interface InboxZeroAPIClient {
  baseUrl: string;
  authToken: string;
}

export async function searchEmails(
  client: InboxZeroAPIClient,
  params: {
    accountId?: string;
    query: string;
    limit?: number;
  },
) {
  const url = new URL(`${client.baseUrl}/api/operator1/emails`);
  if (params.accountId) url.searchParams.set("accountId", params.accountId);
  url.searchParams.set("q", params.query);
  url.searchParams.set("limit", String(params.limit || 50));

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${client.authToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

export async function getEmailThread(client: InboxZeroAPIClient, emailId: string) {
  const response = await fetch(`${client.baseUrl}/api/operator1/emails/${emailId}`, {
    headers: {
      Authorization: `Bearer ${client.authToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

export async function getAccounts(client: InboxZeroAPIClient) {
  const response = await fetch(`${client.baseUrl}/api/operator1/accounts`, {
    headers: {
      Authorization: `Bearer ${client.authToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
```

---

## Part 3: Operator1 Bridge Skill

### Skill Structure

> **Note:** The structure below applies to **Option B (standalone service)** only. For **Option A (OpenClaw hooks pipeline)**, the only artefacts needed are `SKILL.md` (to expose email query tools to the agent) and the `~/.openclaw/hooks/transforms/inbox-zero.js` transform module. No TypeScript service, queue, or circuit breaker is required.

**Option A (hooks pipeline) — minimal:**

```
~/.openclaw/hooks/transforms/
└── inbox-zero.js            # Transform module (see Phase 2 skeleton)

~/dev/operator1/skills/inbox-zero/
└── SKILL.md                 # Exposes searchEmails / getEmailThread tools to agent
```

**Option B (standalone service) — full:**

```
~/dev/operator1/skills/inbox-zero-bridge/
├── SKILL.md                 # Skill documentation
├── handler.ts               # Webhook event handler
├── api-client.ts            # Inbox Zero API client
├── queue/
│   └── index.ts             # BullMQ queue setup
├── security/
│   ├── replay-protection.ts # Nonce + timestamp validation
│   ├── rate-limiter.ts      # Token bucket rate limiting
│   └── webhook-sign.ts      # HMAC signing/verification
└── circuit-breaker.ts       # Gateway circuit breaker
```

### SKILL.md

````markdown
---
name: inbox-zero-bridge
description: Hybrid webhook + API bridge between Inbox Zero and Operator1 for unified email context.
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires":
          {
            "env": ["INBOX_ZERO_URL", "INBOX_ZERO_API_TOKEN", "INBOX_ZERO_WEBHOOK_SECRET"],
            "bins": ["redis-server"],
          },
      },
  }
---

# Inbox Zero Bridge

Bidirectional integration between Inbox Zero email assistant and Operator1.

## Two Integration Modes

| Mode        | Direction              | Use Case                                    |
| ----------- | ---------------------- | ------------------------------------------- |
| **Webhook** | Inbox Zero → Operator1 | Proactive notifications (new email, urgent) |
| **API**     | Operator1 → Inbox Zero | On-demand queries (search, history, sync)   |

## Configuration

Add to openclaw.json:

\`\`\`json
{
"plugins": {
"entries": {
"inbox-zero-bridge": {
"enabled": true,
"webhook": {
"path": "/webhooks/inbox-zero",
"secretEnv": "INBOX_ZERO_WEBHOOK_SECRET"
},
"api": {
"baseUrlEnv": "INBOX_ZERO_URL",
"tokenEnv": "INBOX_ZERO_API_TOKEN"
},
"redis": {
"urlEnv": "REDIS_URL"
},
"accounts": {
"personal@gmail.com": { "label": "Personal", "notify": true },
"work@company.com": { "label": "Work", "notify": true }
}
}
}
}
}
\`\`\`

## Environment Variables

\`\`\`bash
INBOX_ZERO_URL=http://localhost:3000
INBOX_ZERO_API_TOKEN=your-api-token
INBOX_ZERO_WEBHOOK_SECRET=your-webhook-secret
REDIS_URL=redis://localhost:6379
\`\`\`

## Webhook Events

| Event               | Trigger                     | Operator1 Action    |
| ------------------- | --------------------------- | ------------------- |
| \`new_email\`       | New email received          | Analyze, categorize |
| \`urgent_email\`    | Email marked urgent         | Notify via Telegram |
| \`action_required\` | Email contains action items | Create task         |
| \`follow_up\`       | Follow-up scheduled         | Add reminder        |

## API Queries

Ask Operator1:

- "Search my work email for anything from Amazon"
- "What was that email thread with John about?"
- "Show me urgent emails from this week"

## Security

- HMAC-SHA256 webhook signatures
- Timestamp validation (5 min window)
- Nonce-based replay protection
- Rate limiting (100 webhooks/min/account)
- Circuit breaker for gateway failures
- Dead letter queue for failed events
  \`\`\`

---

## Implementation Checklist

### Phase 0: Prerequisite Decisions (before writing any code)

- [ ] **🔑 Key question: Does Inbox Zero already have built-in webhook support?** Inbox Zero's UI includes a "Call Webhook" feature for integrating email processing with external services. If this can be pointed at OpenClaw's hooks endpoint without any fork, the entire Phase 1 fork is eliminated. Verify in the Inbox Zero admin settings before writing any fork code.
- [ ] **Decide Option A vs B:** Use OpenClaw's existing `hooks.mappings` pipeline (preferred — eliminates BullMQ, Redis, custom webhook server) vs. a standalone bridge service. This decision gates all of Phase 2.
- [ ] Verify Inbox Zero's actual Prisma schema — confirm whether a local `email` table exists or if queries must proxy to Gmail API
- [ ] Define the `verifyOperator1Auth` auth mechanism (static bearer token from env var is simplest)

### Phase 1: Inbox Zero Fork (1 day) — _Skip if built-in webhooks are sufficient_

- [ ] Fork Inbox Zero repository
- [ ] Add webhook emission after email processing — emit to configurable URL (may already exist via "Call Webhook" feature)
- [ ] Move HMAC signature to `X-Inbox-Zero-Signature` HTTP header (not inside the body)
- [ ] Add REST API endpoints for Operator1 queries (`/api/operator1/emails`, `/api/operator1/accounts`)
- [ ] Include full email body in webhook payload (not just snippet) for action detection
- [ ] Implement `verifyOperator1Auth` with concrete bearer token auth
- [ ] Add a `patches/` diff file tracking all fork changes for easy rebasing
- [ ] Add CI check that fork builds cleanly against Inbox Zero upstream

### Phase 2: Bridge / Webhook Routing (1 day)

- [ ] **Option A (preferred):** Configure OpenClaw `hooks.mappings` to receive Inbox Zero webhooks + write `~/.openclaw/hooks/transforms/inbox-zero.js` — see transform skeleton below
- [ ] **Option B (standalone service):** Create a separate bridge service (not a skill) with its own start/stop lifecycle and dedicated port; document deploy alongside Gateway
- [ ] Implement API client for on-demand queries
- [ ] If Option B: set up queue with exponential backoff + dead letter (BullMQ or internal `KeyedAsyncQueue`)
- [ ] If Option B: add circuit breaker for Gateway calls
- [ ] Test with sample webhook payloads

#### Option A: Transform Module Skeleton

```javascript
// ~/.openclaw/hooks/transforms/inbox-zero.js
const crypto = require("crypto");

module.exports = async function transform(payload, context) {
  // 1. Verify HMAC signature from header
  const sig = context.headers["x-inbox-zero-signature"] ?? "";
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.INBOX_ZERO_WEBHOOK_SECRET)
      .update(context.rawBody)
      .digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { skip: true }; // hooks pipeline returns 401
  }

  // 2. Map event to agent message
  const { type, data } = payload;
  const prefix =
    {
      urgent_email: "🚨 Urgent email",
      action_required: "📋 Action required",
      follow_up: "🔔 Follow-up reminder",
      new_email: "📧 New email",
    }[type] ?? "📧 Email event";

  return {
    message: `${prefix} from ${data.fromName} <${data.from}>: "${data.subject}"\n\n${data.body ?? data.snippet}`,
    sessionKey: `hook:inbox-zero:${data.threadId}`,
    agentId: "operator1",
  };
};
```
````

OpenClaw config mapping:

```json5
hooks: {
  enabled: true,
  path: "/hooks",
  token: "your-hook-token",
  transformsDir: "~/.openclaw/hooks/transforms",
  mappings: [{
    match: { path: "inbox-zero" },
    action: "agent",
    agentId: "operator1",
    wakeMode: "now",
    name: "Inbox Zero",
    sessionKey: "hook:inbox-zero:{{data.threadId}}",
    deliver: true,
    channel: "last",
    transform: { module: "inbox-zero.js", export: "default" },
  }],
}
```

### Phase 3: Security & Reliability (0.5 day)

- [ ] Implement replay protection (nonce + timestamp, 5 min window)
- [ ] Add rate limiting per account
- [ ] Set up dead letter queue / failure logging
- [ ] Add health check endpoint
- [ ] Document secret rotation procedure (overlap window for old + new secret)

### Phase 4: Operator1 Integration (0.5 day)

- [ ] Update `agents/operator1/agent.yaml` and AGENT.md to describe email capabilities and available tools
- [ ] Add multi-account disambiguation logic (default account + explicit account selection)
- [ ] Implement categorization logic and task creation from action emails
- [ ] Add Telegram notifications for urgent emails
- [ ] Add inbox overview / unread count query (`GET /api/operator1/emails/summary`)
- [ ] Test end-to-end with real email

#### Testing

- [ ] Unit tests for transform module: HMAC verification, event-type mapping, sessionKey generation
- [ ] Integration test: send a mock webhook payload and verify agent receives correct message
- [ ] Failure scenario tests: bad signature → 401, rate limit → 429, gateway down → queue/retry
- [ ] End-to-end test with a real email account (trigger → webhook → Telegram notification)
- [ ] Rollback test: disable hook mapping and confirm no events reach the agent

#### Rollback

- **Option A:** Set `hooks.mappings[].enabled: false` in `openclaw.json` and reload — zero downtime
- **Option B:** Stop the bridge service; Inbox Zero continues working, just stops delivering to Operator1
- **Inbox Zero side:** Disable the "Call Webhook" rule in Inbox Zero settings UI
- Dead letter queue (Option B) or gateway logs (Option A) provide an audit trail of events during the outage

#### Monitoring

- Dead letter queue depth (Option B) — alert if growing; indicates Gateway is unreachable or transform is broken
- Webhook delivery failures on the Inbox Zero side — visible in Inbox Zero's webhook activity log
- Gateway circuit breaker state changes (Option B) — log `open` / `close` transitions
- Telegram notification failures — surface via Operator1's existing error reporting
- Transform error rate (Option A) — add a counter in the transform module; log to `~/.openclaw/logs/`

### Phase 5: Email Actions (future — not in initial scope)

- [ ] Reply endpoint (`POST /api/operator1/emails/[id]/reply`)
- [ ] Archive / label endpoint (`PATCH /api/operator1/emails/[id]`)
- [ ] Expose reply/archive as Operator1 tools

---

## Benefits

| Benefit                  | Description                                    |
| ------------------------ | ---------------------------------------------- |
| **Proactive + Reactive** | Webhooks for events, API for queries           |
| **Secure**               | HMAC signing, replay protection, rate limiting |
| **Reliable**             | Retry queue, dead letter, circuit breaker      |
| **Minimal fork**         | Easy to rebase on Inbox Zero upstream          |
| **Unified memory**       | Email context flows to Operator1               |
| **Chat integration**     | "What emails need attention?" via Telegram     |

---

## Trade-offs

| Trade-off                   | Impact                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Fork may not be needed**  | Inbox Zero has a built-in "Call Webhook" feature — if it works, no fork required at all; verify in Phase 0 |
| **Minimal fork if needed**  | Not zero-code, but small diff; track via `patches/` dir                                                    |
| **Fork maintenance burden** | Only applies if fork is required; Inbox Zero updates frequently — needs upstream sync strategy + CI        |
| **Redis dependency**        | Required for queue + rate limiting if bridge is standalone; not needed if using OpenClaw hooks pipeline    |
| **Two systems**             | Inbox Zero + Operator1 both running                                                                        |
| **Read-only initially**     | No reply/archive in v1; Phase 5 covers actions                                                             |
| **Full body in webhook**    | Larger webhook payloads; required for action detection                                                     |

---

## Gap Analysis

### 🔴 Critical Architectural Gaps

| Gap                                                  | Detail                                                                                                                                                                                                                  | Resolution                                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bridge Skill is a microservice, not a skill**      | Every skill in `skills/` is a pure `SKILL.md` that teaches the agent about CLI tools. Skills are not standalone HTTP servers with queues. The bridge as designed needs to be called a separate service or be rethought. | Either reframe as a standalone bridge service with its own deploy lifecycle, or (preferred) route Inbox Zero webhooks through OpenClaw's existing `hooks.mappings` system                                        |
| **OpenClaw already has a webhook/hooks system**      | `src/hooks/` + the `hooks` config block handles webhook reception, token auth, agent routing, session management, message templating, and delivery. The proposal reinvents this entirely.                               | Use `hooks.mappings` + a custom `transforms/inbox-zero.js` module for the webhook side. Eliminates BullMQ, custom webhook handler, and circuit breaker. Cuts webhook implementation to ~1 custom transform file. |
| **BullMQ + Redis has no precedent in this codebase** | The codebase uses `KeyedAsyncQueue` / `enqueueCommandInLane` (`src/process/command-queue.ts`) internally — no BullMQ, no Redis.                                                                                         | If using OpenClaw's hooks pipeline, BullMQ is unnecessary. If a standalone service is chosen, BullMQ is fine but Redis becomes a required new daemon — operational cost must be justified.                       |

### 🟠 Technical Bugs in Proposed Code

| Bug                                                   | Detail                                                                                                                                                                                            | Fix                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HMAC signature embedded in body (circular)**        | Payload has `"signature": "sha256=..."` as a JSON field inside the body. If the signature is computed over the full body, it can't be embedded in that same body.                                 | Move signature to `X-Inbox-Zero-Signature` HTTP header, computed over the raw request body before serialization.                                                 |
| **`prisma.email` table may not exist**                | Inbox Zero fetches emails from Gmail/Outlook APIs dynamically via `ThreadFull` types. It is not a local email store in most configurations.                                                       | Verify the actual Inbox Zero Prisma schema. API endpoints may need to proxy Gmail API calls rather than query a local table.                                     |
| **`verifyOperator1Auth` is undefined**                | Referenced in every API endpoint but never implemented.                                                                                                                                           | Define concretely — simplest option: `Authorization: Bearer ${INBOX_ZERO_API_TOKEN}` header check against an env var.                                            |
| **`openclaw/gateway/call` import path doesn't exist** | `api-client.ts` imports `callGateway, randomIdempotencyKey` from `"openclaw/gateway/call"` — not a valid path. Actual invocation uses `dispatchGatewayMethod` in `src/gateway/server-plugins.ts`. | Fix import path; also note that `api-client.ts` only fetches from the HTTP API — a separate layer is needed to call `dispatchGatewayMethod` and reach the agent. |
| **BullMQ import is wrong**                            | `import Queue, { Job } from "bullmq"` — BullMQ 5.x uses named exports. `webhookQueue.add()` called at module top-level will error on import.                                                      | `import { Queue, Worker, Job } from 'bullmq'`; move `queue.add()` inside the event handler.                                                                      |

### 🟡 Operational Gaps

| Gap                                            | Detail                                                                                                                                   | Resolution                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No setup/onboarding flow**                   | No step-by-step: how does Inbox Zero learn the webhook URL? No setup script or `openclaw` CLI commands described.                        | Add a Phase 0 setup checklist: fork setup → set env vars → register webhook URL in Inbox Zero config → verify with test payload.                 |
| **Fork maintenance has no strategy**           | Inbox Zero is actively developed. "Easy to rebase" is stated but not backed by tooling.                                                  | Track all fork changes in a `patches/` diff file. Add CI check that fork builds against Inbox Zero upstream main. Define a monthly sync cadence. |
| **Redis operational requirements unaddressed** | Redis is a required daemon if standalone bridge is chosen. No mention of startup, conflict with other Redis usage, or dev-mode fallback. | Document Redis setup in SKILL.md / bridge README. Consider whether the existing OpenClaw hooks pipeline eliminates this requirement.             |
| **No secret rotation strategy**                | Webhook secrets and API tokens mentioned but no rotation mechanism, overlap window, or versioning.                                       | Define rotation procedure: support old + new secret simultaneously during rotation window using a `INBOX_ZERO_WEBHOOK_SECRET_PREV` env var.      |

### 🟡 Missing Capabilities

| Missing                                       | Detail                                                                                                               | Resolution                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **No Operator1 agent.yaml / AGENT.md update** | Agent has no knowledge it can query email. No changes to `agents/operator1/agent.yaml` or AGENT.md described.        | Add email capability description, tool hints, and account list to AGENT.md / boot-md.            |
| **Webhook payload has snippet only**          | For action detection and draft-reply generation, Operator1 needs the full email body. Gmail's snippet is ~150 chars. | Include full body in webhook payload, or have the bridge always fetch full email on every event. |
| **No multi-account disambiguation**           | When user says "check my email," no logic for which account(s) to query.                                             | Add account selection logic to agent system prompt; default to all accounts if unspecified.      |
| **No inbox overview / unread count**          | Most common query ("what's in my inbox?") has no dedicated endpoint.                                                 | Add `GET /api/operator1/emails/summary` returning unread count + top urgent items per account.   |
| **Read-only integration**                     | No reply, archive, label, or mark-as-read from Operator1.                                                            | Planned as Phase 5: `POST /emails/[id]/reply`, `PATCH /emails/[id]` for archive/label.           |

### ✅ What's Solid (no changes needed)

| Item                                      | Notes                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Hybrid webhook + API pattern              | Right architectural direction                                           |
| HMAC-SHA256 timing-safe comparison        | Correct implementation                                                  |
| Timestamp + nonce replay protection logic | Sound approach                                                          |
| Rate limiting concept                     | Appropriate; implementation correct once Redis decision is made         |
| Dead letter queue concept                 | Good; implementation details need BullMQ import fix                     |
| Circuit breaker concept                   | Valid; `opossum` is a reasonable choice if standalone service is chosen |

---

## Related Documents

- `/Project-tasks/agent-marketplace-implementation.md` — Agent marketplace design
- `~/dev/operator1/skills/clawhub/SKILL.md` — ClawHub for skill distribution

---

## Discussion History

**2026-03-09 — Initial Research**

User has 3+ email accounts, wants AI-powered email management integrated with Operator1. Researched Inbox Zero as integration point.

**2026-03-10 — Claude Code Review**

Identified critical gaps:

- Security: HMAC signing, replay protection, rate limiting
- Error handling: retry queue, dead letter, circuit breaker
- Technical: API + Webhook hybrid approach

**2026-03-10 — Hybrid Approach**

User confirmed:

- Webhook for proactive updates (new emails)
- API for on-demand queries (large data)
- Remove Options B/C, focus on single integration plan
- Address all security and reliability gaps

**2026-03-10 — Full Gap Analysis**

Deep review of proposal against actual OpenClaw codebase identified:

- Critical: "Bridge Skill" is a microservice pattern, not a skill — skills are SKILL.md only; TypeScript services need separate deployment
- Critical: OpenClaw already has `hooks.mappings` webhook pipeline — can eliminate BullMQ, custom webhook server, circuit breaker
- Critical: HMAC signature must go in HTTP header, not JSON body (circular dependency)
- Critical: Inbox Zero may not have a local `prisma.email` table — need to verify schema
- High: `verifyOperator1Auth` and `openclaw/gateway/call` import path are both undefined/invalid
- High: BullMQ import syntax is wrong; `queue.add()` called at module load level
- Medium: No AGENT.md/agent.yaml update, no multi-account logic, no full body in webhook, no inbox overview endpoint
- Added Phase 0 (prerequisite decisions) and Phase 5 (email actions) to checklist
- Added fork maintenance strategy, secret rotation, and onboarding flow as required gaps

**2026-03-10 — Senior Developer Review**

Reviewed gap analysis and confirmed all findings. Additional points raised:

- Inbox Zero has a built-in "Call Webhook" feature — may eliminate the need for a fork entirely; added as the first Phase 0 decision
- `transforms/inbox-zero.js` example skeleton added to Phase 2 to make Option A concrete and actionable
- Webhook error response behavior documented (200 on ack, 401 on bad sig, 429 on rate limit, 503 on breaker open)
- Option A vs B decision moved explicitly into Phase 0 (previously only listed in Phase 2)
- Webhook payload updated: removed `signature` field from body, added `body` field for full email content
- Trade-offs updated: fork may not be required at all pending Phase 0 verification

**2026-03-10 — Final Polish Pass**

Minor refinements applied:

- Architecture diagram title updated to "Inbox Zero (Self-Hosted or Cloud)" — fork may not be required
- "Current Integration State" table updated: external webhooks now ⚠️ with note about built-in "Call Webhook" feature
- Skill Structure section split into Option A (minimal) and Option B (full service) layouts with explanatory note
- "How Operator1 Invokes the API" section added: three invocation options (skill+CLI wrapper preferred), flagged invalid `openclaw/gateway/call` import
- Testing checklist added to Phase 4 (unit, integration, failure scenario, e2e, rollback)
- Rollback procedure added to Phase 4 (hooks disable, bridge stop, Inbox Zero UI, audit trail)
- Monitoring section added to Phase 4 (DLQ depth, webhook delivery, circuit breaker, Telegram failures, transform error rate)

---

_Last updated: 2026-03-10_
