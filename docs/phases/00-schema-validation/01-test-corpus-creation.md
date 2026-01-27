# Phase 0, Task 01: Test Corpus Creation

**Phase:** 0 - Schema Validation & Ground Truth
**Task:** Create test corpus for entity extraction validation
**Duration:** 0.5 day
**Complexity:** Low

---

## Task Overview

Create a diverse test corpus of 10 sample documents that will be used to validate the entity extraction pipeline quality. These documents must represent realistic content types that Clawdbot users will ingest.

## Deliverables

1. Directory: `docs/plans/graphrag/test-corpus/`
2. Files:
   - `auth-service-spec.pdf` - API specification
   - `payment-flow.docx` - Design document
   - `architecture-decision.md` - Markdown technical doc
   - `api-client.ts` - TypeScript source file
   - `meeting-notes.txt` - Plain text notes
   - `docs-site.html` - HTML documentation
   - `deployment-guide.md` - Operations document
   - `entity-model.json` - Data model
   - `changelog.md` - Release notes
   - `debug-session.md` - Bug investigation notes

## Document Content Requirements

Each document should contain realistic entities and relationships:

### Entity Types to Include:
- **Person:** Alice Chen, Bob Smith, Carol Wu
- **Organization:** Clawdbot, Acme Corp, Stripe
- **Repository:** clawdbot/core, acme/payment-lib
- **Concept:** JWT authentication, Webhook delivery, Rate limiting
- **Tool:** Redis, PostgreSQL, RabbitMQ
- **Location:** us-east-1, EU-West, /api/v1/auth
- **Event:** deploy_prod_2024_01_15, webhook_failure_event
- **Goal:** Implement OAuth2 flow, Reduce latency by 50%
- **Task:** Add retry logic, Update dependencies
- **File:** AuthService.ts, payment_handler.py

### Relationship Types to Include:
- `depends_on` - Service dependencies
- `implements` - Interface implementations
- `located_in` - Infrastructure placement
- `created_by` - Authorship
- `related_to` - General associations
- `part_of` - Hierarchical relationships
- `calls` - API/service calls

### Edge Cases to Include:
1. **Aliases:** "Auth Service" vs "AuthService" vs "auth service"
2. **Typos:** "Paymnet" vs "Payment"
3. **Acronyms:** "JWT" vs "JSON Web Token"
4. **Nested relationships:** Service -> Component -> Function
5. **Temporal references:** "previous version" vs "v2.0"
6. **Ambiguous references:** "the client" (could refer to software or person)

## Content Examples

### auth-service-spec.pdf
```markdown
# Authentication Service API Specification

## Overview
The Auth Service handles JWT authentication for all Clawdbot components.

## Endpoints

### POST /api/v1/auth/login
Authenticates users and returns a JWT token.

**Request Body:**
```json
{
  "username": "alice@example.com",
  "password": "hashed_password"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 3600
}
```

## Dependencies
- Redis for token blacklisting
- PostgreSQL for user data
- Calls UserService for profile validation

## Implementation
Implemented by Alice Chen on 2024-01-15.
Depends on clawdbot/core library v2.1.
```

### api-client.ts
```typescript
/**
 * API Client for Auth Service
 *
 * @author Bob Smith
 * @version 1.2.0
 */

import { HttpClient } from '@clawdbot/core';

export class AuthClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'https://api.clawdbot.com') {
    this.baseUrl = baseUrl;
  }

  /**
   * Authenticate user credentials
   * @param username User email or username
   * @param password User password
   * @returns JWT token
   */
  async login(username: string, password: string): Promise<string> {
    const client = new HttpClient(this.baseUrl);
    const response = await client.post('/api/v1/auth/login', {
      username,
      password,
    });

    return response.token;
  }
}

/**
 * Payment handler for Stripe integration
 * @author Carol Wu
 * Located in payment-service component
 */
export class StripePaymentHandler {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async processPayment(amount: number, currency: string): Promise<PaymentResult> {
    // Payment processing logic
    // Calls Stripe API
    // Logs to RabbitMQ
  }
}
```

### meeting-notes.txt
```
Meeting Notes: Architecture Review 2024-01-20
Attendees: Alice Chen, Bob Smith, Carol Wu

Action Items:
1. Alice to implement OAuth2 flow in Auth Service
2. Bob to update payment handler retry logic
3. Carol to investigate webhook failure in production

Decisions:
- Migrate from Redis to Redis Cluster for high availability
- Add rate limiting to /api/v1/auth endpoint
- Decommission legacy Auth Service v1 by 2024-03-01

Related Tickets:
- AUTH-123: Add OAuth2 support
- PAY-456: Fix payment race condition
- DEPLOY-789: Deploy to us-east-1 region
```

## Validation Criteria

After creating the corpus, verify:

1. **Coverage:** All entity types are represented across documents
2. **Diversity:** Mix of technical and non-technical content
3. **Realism:** Content reflects actual documentation patterns
4. **Complexity:** Includes nested relationships and ambiguous references
5. **Edge Cases:** Typos, aliases, and temporal variations present

## Success Criteria

- [ ] 10 documents created in specified formats (PDF, DOCX, MD, TS, TXT, HTML)
- [ ] All entity types present (person, org, repo, concept, tool, location, event, goal, task, file)
- [ ] All relationship types represented
- [ ] Edge cases intentionally included
- [ ] Documents total 2000-3000 words (enough content for extraction testing)
- [ ] Each document includes realistic entity density (5-15 entities per document)

## References

- Entity Type Definitions: See `docs/plans/graphrag/ZAI-FINAL-DECISIONS.md` section "Entity Types"
- Relationship Type Definitions: See `docs/plans/graphrag/ZAI-DECISIONS.md` AD-05
- Extraction Pipeline Design: See `docs/plans/graphrag/ZAI-UPDATED-DESIGN.md` Part 2

## Next Task

After completing this task, proceed to `02-manual-entity-extraction.md` to create the ground truth extraction results.
