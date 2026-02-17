# E-Commerce Governance Example: Shopify + Agent Contracts

> **Audience:** Platform operators, prospective tenants, internal reference
>
> **Purpose:** Concrete example of where traditional code, agent monitoring, and
> permission contracts each apply in a real business context.

---

## Table of Contents

1. [The Core Principle](#1-the-core-principle)
2. [Architecture Layers](#2-architecture-layers)
3. [What Handles What](#3-what-handles-what)
4. [Scenario Walkthroughs](#4-scenario-walkthroughs)
5. [Tool Profiles and Contracts](#5-tool-profiles-and-contracts)
6. [The Maturity Progression](#6-the-maturity-progression)
7. [Daily Rhythm of a Mostly-Automated Business](#7-daily-rhythm-of-a-mostly-automated-business)
8. [Contract Examples (Code)](#8-contract-examples-code)

---

## 1. The Core Principle

**If you can write an if-else for it, don't use an agent.**

Traditional code handles the deterministic plumbing — webhooks, payment
processing, inventory sync, tax calculation. This is fast, reliable, and
testable. It never needs AI.

Agents handle the things you can't write if-else for — pattern recognition
across noisy data, natural language communication, reasoning about ambiguous
situations, multi-factor decision-making.

Contracts govern the boundary between "watching" and "touching." An agent can
observe anything (read-only tool profile). But to change anything, it needs a
signed, time-bound, scope-limited permission contract.

**GenAI excels at:**

- Pattern recognition across noisy data (anomaly detection)
- Natural language (customer communication, supplier negotiation)
- Reasoning about ambiguous situations (should we pause this product?)
- Creative tasks (marketing copy, product descriptions)
- Multi-factor decision-making (pricing considering 10 variables)

**Traditional code excels at:**

- Deterministic workflows (order -> fulfill -> ship)
- Data transformation (webhook -> database -> API)
- Transactional integrity (payment processing)
- High-throughput processing (1000 orders/second)
- Regulated operations (tax calculation, compliance)

---

## 2. Architecture Layers

```
+----------------------------------------------------------------------+
|  Layer 0: Traditional Code (webhooks, APIs, cron jobs)               |
|  Deterministic. Fast. Reliable. No AI. No contracts.                 |
|  This IS the business.                                               |
+----------------------------------------------------------------------+
|  Layer 1: Agent Monitoring (read-only, always on)                    |
|  Agents observe order data, inventory, customer patterns.            |
|  No contracts needed -- tool profile restricts to read APIs.         |
+----------------------------------------------------------------------+
|  Layer 2: Agent Investigation (deeper reads, standing permission)    |
|  Agent notices anomaly, digs into customer feedback, batch data.     |
|  Standing read contract for deeper queries.                          |
+----------------------------------------------------------------------+
|  Layer 3: Agent Recommendation (analysis + proposal)                 |
|  Agent produces a report with a recommended action.                  |
|  No write access. Just analysis.                                     |
+----------------------------------------------------------------------+
|  Layer 4: Agent Action (time-bound contract, scoped write access)    |
|  Human approves -> permission contract created -> agent executes     |
|  Contract is scoped, time-limited, and logged on the ledger.         |
+----------------------------------------------------------------------+
```

The traditional code layer runs 24/7 without interruption. The agent layers
sit on top, observing, analyzing, and occasionally intervening -- but only
when authorized by a signed contract.

---

## 3. What Handles What

| Operation                     | Handler                                  | Contract Required?                 |
| ----------------------------- | ---------------------------------------- | ---------------------------------- |
| Order fulfillment             | Traditional code (webhook -> API)        | No                                 |
| Payment processing            | Traditional code (Shopify)               | No                                 |
| Shipping label generation     | Traditional code (API)                   | No                                 |
| Inventory sync                | Traditional code (cron)                  | No                                 |
| Tax calculation               | Traditional code (API)                   | No                                 |
| Email confirmations           | Traditional code (template trigger)      | No                                 |
| Return processing             | Traditional code (webhook -> refund API) | No                                 |
| **Monitoring order patterns** | **Agent (read-only)**                    | **No -- tool profile only**        |
| **Investigating anomalies**   | **Agent (deeper reads)**                 | **Standing read contract**         |
| **Drafting communications**   | **Agent (no write)**                     | **No -- it's a draft**             |
| **Sending customer emails**   | **Agent (write)**                        | **Yes -- scoped contract**         |
| **Pausing a product listing** | **Agent (write)**                        | **Yes -- time-bound contract**     |
| **Adjusting prices**          | **Agent (write)**                        | **Yes -- bounded contract**        |
| **Creating purchase orders**  | **Agent (write)**                        | **Yes -- dollar-limited contract** |
| **Issuing refunds**           | **Agent (write)**                        | **Yes -- amount-limited contract** |

The pattern: everything that flows the same way every time is traditional code.
Everything that requires judgment, interpretation, or decision-making involves
an agent. Everything an agent writes requires a contract.

---

## 4. Scenario Walkthroughs

### 4.1 Normal Order Flow

```
Customer places order on Shopify
    -> Shopify fires order.created webhook
    -> Your Lambda/worker:
        1. Validates payment status
        2. Creates fulfillment record
        3. Generates shipping label (EasyPost/ShipStation API)
        4. Sends confirmation email (template)
        5. Decrements inventory
    -> Done. ~200ms. No agent involved.

Ledger:    Records the order event (warm tier, batched into Merkle root later)
Dashboard: Shows order in real-time feed (hot tier, WebSocket)
Agent:     ZERO involvement
Contract:  None needed
```

This is the backbone of the business. Thousands of orders a day, fully
deterministic, fully tested. Agents have no role here.

---

### 4.2 Return Rate Anomaly

**Phase 1 -- Traditional code does its job**

```
Customer requests return -> Shopify webhook -> process return, issue refund
Customer requests return -> Shopify webhook -> process return, issue refund
Customer requests return -> Shopify webhook -> process return, issue refund
... (each one handled identically by traditional code)
```

**Phase 2 -- Agent monitoring detects a pattern**

```
COO Agent (read-only tool profile, no contract needed):
    -> Periodically reads orders and returns data via Shopify API
    -> Notices: Product X return rate jumped from 3% to 14% this week
    -> Flags anomaly internally
```

**Phase 3 -- Agent investigates (standing read contract)**

```
COO Agent (standing contract: deeper Shopify queries):
    -> Queries return reasons for Product X: 19 of 23 cite "broken clasp"
    -> Pulls supplier batch info: all returns from batch #4472
    -> Checks customer reviews: 4 new 1-star reviews mentioning clasp
    -> Cross-references with other products from same supplier: normal rates
```

**Phase 4 -- Agent produces recommendation (no write access)**

```
COO Agent produces report:

    "Product X -- Batch #4472 Defect Alert

     Return rate: 14% (baseline 3%). 23 returns, 19 citing broken clasp.
     All from supplier batch #4472 shipped 2025-05-20.

     Recommended actions:
     1. Pause Product X listing immediately
     2. Contact Supplier A RE: batch #4472 defect
     3. Send apology + replacement offer to 23 affected customers

     Estimated cost: $1,150 (23 replacements at $50 avg)"

Report -> Dashboard + Signal notification to human operator
```

**Phase 5 -- Human approves (30 seconds on phone)**

```
Human reads report on Signal.
Replies: APPROVE

System creates time-bound permission contract:
    Subject:      COO agent DID
    Actions:      ["shopify.product.update", "email.template.send"]
    Targets:      [shopify-tool-DID, email-tool-DID]
    Constraints:  { productId: "X", newStatus: "paused",
                    templateId: "defect-apology", maxRecipients: 30 }
    Duration:     2 hours
    Signed by:    Human operator's Ed25519 key
```

**Phase 6 -- Agent executes within contract bounds**

```
COO Agent:
    -> Pauses Product X listing via Shopify API         ALLOWED (in contract)
    -> Sends defect-apology template to 23 customers    ALLOWED (in contract)
    -> Attempts to issue refunds                        DENIED  (not in contract)
    -> All actions recorded on ledger (cold tier)
    -> Contract expires after 2 hours

Ledger entries:
    [cold] contract.create  -- operator issued contract for COO
    [cold] agent.command    -- COO updated product X status to paused
    [cold] agent.command    -- COO sent email template to 23 recipients
    [cold] contract.expire  -- contract TTL expired (2h)
```

---

### 4.3 Inventory Reorder (Maturity Progression)

This scenario shows how the same operation evolves as trust is established.

**Maturity Level 1 -- Human-in-the-loop (month 1-2)**

```
Traditional code: detects inventory below threshold, fires event.
CFO Agent:  reads inventory data, recommends PO.
            "Reorder 500 units of Widget A from Supplier B. Est. cost: $2,400."
Human:      reviews, approves.
Contract:   time-bound, single PO:
            { supplier: "B", product: "A", qty: 500, maxAmount: 2500 }
CFO Agent:  creates PO, sends to supplier.
```

Every reorder requires human approval. The agent does the analysis and
paperwork; the human makes the call.

**Maturity Level 3 -- Human-on-the-side (month 6+)**

```
CFO Agent has a standing contract (renewed monthly after human review):
    Actions:     ["supplier.po.create"]
    Constraints: { maxAmount: 5000,
                   approvedSuppliers: ["supplier-A", "supplier-B"],
                   approvedProducts: ["widget-*"] }
    Duration:    30 days

Routine reorder ($2,400 to Supplier B):
    -> CFO creates PO autonomously -- within contract bounds
    -> Logged on ledger, visible on dashboard
    -> Human sees it in the daily summary, not in real-time

Unusual reorder ($8,000 rush shipment):
    -> Exceeds $5,000 maxAmount constraint
    -> CFO escalates to human via Signal
    -> Human approves -> time-bound contract for this specific PO
    -> CFO executes
```

The standing contract replaces the per-action approval loop for routine
operations. The bounds ensure the agent can't go rogue -- anything outside
the contract requires escalation.

---

### 4.4 Customer Support

**Maturity Level 1 -- Every response reviewed**

```
Customer emails: "My order arrived damaged"

COO Agent:  reads ticket (read-only, no contract)
            -> Pulls order history, shipping records, product photos
            -> Drafts response: "Sorry about the damage. We'll send
               a replacement immediately and email you a return label."
            -> Draft goes to human for review
Human:      edits slightly, approves.
Contract:   time-bound: send this response + issue $34.50 refund
COO Agent:  sends response, processes refund.
```

**Maturity Level 3 -- Routine autonomy with limits**

```
COO Agent has a standing contract:
    Actions:     ["support.respond", "refund.issue"]
    Constraints: { maxRefundAmount: 50, templateCategories: ["damage", "delay", "missing"] }
    Duration:    30 days

Damaged item complaint ($34.50 refund):
    -> COO reads ticket, drafts and sends response autonomously
    -> Issues $34.50 refund -- within $50 limit
    -> Logged on ledger, human sees in daily summary

Complaint about $200 item:
    -> COO reads, drafts response
    -> Refund ($200) exceeds $50 standing contract limit
    -> COO escalates to human: "Recommending $200 refund for [reason]"
    -> Human approves -> time-bound contract for this refund -> done
```

---

### 4.5 Pricing Optimization

```
Traditional code: applies scheduled price rules (sale events, bundle discounts, tax)

CFO Agent (read-only): analyzes sales velocity, margins, competitor pricing
    -> Recommends: "Increase Product Y by 8% -- competitor raised 12%,
       our margin is thin, demand steady."

Standing contract (Maturity 3):
    Actions:     ["shopify.product.price.update"]
    Constraints: { maxChangePercent: 10, excludeCategories: ["clearance"] }
    Duration:    30 days

Price adjustment within 10%:
    -> CFO adjusts autonomously. Logged.

Price drop of 25% for flash sale:
    -> Exceeds 10% constraint.
    -> CFO proposes plan to human.
    -> Human approves -> time-bound contract with 25% limit for 48 hours.
```

---

## 5. Tool Profiles and Contracts

OpenClaw's tool profiles control what APIs an agent can even _see_.
Permission contracts control what the agent is _authorized to execute_.

**Shopify tool definitions:**

| Tool Name                    | Type  | Available To            | Contract Required? |
| ---------------------------- | ----- | ----------------------- | ------------------ |
| `shopify_read_orders`        | Read  | All agents              | No                 |
| `shopify_read_products`      | Read  | All agents              | No                 |
| `shopify_read_inventory`     | Read  | All agents              | No                 |
| `shopify_read_customers`     | Read  | COO, Research           | No                 |
| `shopify_read_analytics`     | Read  | CFO, CEO                | No                 |
| `shopify_update_product`     | Write | COO (in profile)        | Yes                |
| `shopify_update_price`       | Write | CFO (in profile)        | Yes                |
| `shopify_issue_refund`       | Write | COO (in profile)        | Yes                |
| `shopify_create_fulfillment` | Write | None (traditional code) | N/A                |

The tool profile determines visibility. The contract determines authorization.
An agent with `shopify_update_product` in its tool profile can _see_ the tool,
but calling it without an active contract returns DENIED.

**Two gates, not one:**

```
Agent wants to update a product
    -> Gate 1: Tool profile check (can the agent see this tool?)
       If no -> tool not even available. Silent.
    -> Gate 2: Contract check (does the agent have authorization?)
       If no -> DENIED. Logged on ledger. Alert on dashboard.
    -> Both pass -> execute. Log on ledger.
```

---

## 6. The Maturity Progression

The maturity model is the mechanism for progressive trust. Same agent, same
tools, same contracts -- the scope broadens as the agent proves reliable.

| Level | Name              | Contract Model                             | Human Involvement                            | Example                 |
| ----- | ----------------- | ------------------------------------------ | -------------------------------------------- | ----------------------- |
| 1     | Human-in-the-loop | Per-action time-bound contracts            | Every action approved                        | Month 1-2 of deployment |
| 2     | Human-on-the-loop | Short-duration standing contracts (24h-7d) | Reviews daily summary, approves batches      | Month 3-4               |
| 3     | Human-on-the-side | Long-duration standing contracts (30d)     | Weekly review, handles escalations only      | Month 6+                |
| 4     | Full autonomy     | Broad standing contracts, auto-renewed     | Monthly board meeting, emergency escalations | Month 12+               |

**Promotion criteria (Level 2 -> Level 3 example):**

- Agent has operated at Level 2 for 60+ days
- Task completion rate > 95%
- Zero SOC alerts in the last 30 days
- Human override rate < 5% (agent recommendations accepted 95%+ of the time)
- Human operator signs a maturity promotion contract (logged on ledger)

**Demotion triggers (any level):**

- SOC alert (behavioral anomaly detected)
- Contract violation attempt (action outside scope)
- Human override rate exceeds threshold
- Explicit human decision

Promotion and demotion are both governance events recorded on the ledger
with full justification.

---

## 7. Daily Rhythm of a Mostly-Automated Business

At Maturity Level 3, a human operator's day looks like this:

**Automatic (no human involvement):**

- Orders flow: webhook -> fulfill -> ship -> confirm (traditional code, 24/7)
- Inventory reorders under $5,000 (CFO standing contract)
- Customer support responses + refunds under $50 (COO standing contract)
- Price adjustments within 10% (CFO standing contract)
- Monitoring and anomaly detection (all agents, read-only)
- Daily agent standup meeting (agents report status to each other)

**Morning briefing (5 minutes, on phone):**

- CEO agent produces overnight summary on Signal
- 47 orders fulfilled, 3 returns processed, 1 PO created
- "No anomalies. Revenue tracking 12% above forecast."
- Human reads, no action needed.

**Escalation (maybe 1-2 per week, 5 minutes each):**

- CFO: "Rush PO needed, $8,000, exceeds standing contract. Approve?"
- Human: APPROVE -> time-bound contract -> done.
- COO: "Customer requesting $200 refund, exceeds standing limit."
- Human: Reviews details, APPROVE -> done.

**Weekly review (15 minutes):**

- Dashboard: review agent performance metrics, contract utilization
- Renew or adjust standing contracts as needed
- Review SOC alerts (if any)
- Sign maturity promotion if criteria met

**Total human time: ~30 minutes per week** at Maturity 3. The business
runs itself within the bounds of the signed contracts. The ledger records
everything. The dashboard shows everything. The contracts limit everything.

---

## 8. Contract Examples (Code)

Using the `@six-fingered-man/governance/contracts` package:

### Create a standing inventory contract

```typescript
import { PermissionContractService } from "@six-fingered-man/governance/contracts";
import { generateDID } from "@six-fingered-man/governance/identity";

const service = new PermissionContractService({ store, ledger });

// Human operator creates a 30-day standing contract for CFO
const contract = await service.create({
  issuerDid: operator.did,
  issuerPrivateKey: operator.privateKey,
  subjectDid: cfoAgent.did,
  actions: ["supplier.po.create"],
  targetAgents: [supplierTool.did],
  durationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  constraints: {
    maxAmount: 5000,
    approvedSuppliers: ["supplier-A", "supplier-B"],
  },
});
// contract.id = "a1b2c3..." (SHA-256 content-addressed)
// contract.proof.proofValue = "z..." (Ed25519 signature)
// contract.status = "active"
```

### Check authorization before agent action

```typescript
// CFO wants to create a PO
const result = service.check({
  actorDid: cfoAgent.did,
  action: "supplier.po.create",
  targetDid: supplierTool.did,
});

if (result.allowed) {
  // Execute the action -- contract.id is logged on the ledger
  await createPurchaseOrder(poDetails);
} else {
  // Escalate to human -- result.reason explains why
  await escalate({
    agent: cfoAgent.did,
    action: "supplier.po.create",
    reason: result.reason, // "No matching active contract"
    recommendation: poDetails,
  });
}
```

### Time-bound contract from human approval

```typescript
// Human approved a specific action via Signal
const approval = await service.create({
  issuerDid: operator.did,
  issuerPrivateKey: operator.privateKey,
  subjectDid: cooAgent.did,
  actions: ["shopify.product.update", "email.template.send"],
  targetAgents: [shopifyTool.did, emailTool.did],
  durationMs: 2 * 60 * 60 * 1000, // 2 hours
  constraints: {
    productId: "product-x",
    newStatus: "paused",
    templateId: "defect-apology",
    maxRecipients: 30,
  },
});

// Agent executes within bounds, contract auto-expires after 2 hours
```

### Verify a contract's signature (audit)

```typescript
// During audit or on import from storage
const isValid = service.verify(contract);
// true = signature matches issuer's DID public key
// false = contract has been tampered with
```

---

## Summary

The agents are not replacing Shopify webhooks. They are the operators watching
the factory floor. They need a signed work order (contract) before they touch
any machinery. The work order says exactly what they can do, to what, for how
long. Everything is logged. Everything is verifiable. And the bounds get wider
as the agent earns trust.

Traditional code is the business. Agents are the operators. Contracts are the
keys. The ledger is the receipt book.
