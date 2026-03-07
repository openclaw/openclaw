# Prompt-First Operating Model

## Core Principle

OpenClaw is designed as a **prompt-first operating system**.

Users interact with the system using plain English conversation — not commands,
scripts, or terminal instructions.

OpenClaw interprets intent from natural language and converts that intent into
system actions.

This means the user should be able to say things like:

- "Find new grants for Full Digital."
- "Generate three ad concepts for CUTMV."
- "Check the health of the cluster."
- "Start the daily marketing run."
- "Why did yesterday's ads underperform?"

OpenClaw translates those requests into the appropriate internal workflows.
Users should never need to know which scripts, APIs, or commands are running
behind the scenes.

---

## Interaction Modes

OpenClaw supports four interaction modes:

### 1. Prompt → Conversation

Normal chat with the system.

> "What should we focus on today for Full Digital?"

OpenClaw responds with analysis, insights, and recommendations.

### 2. Prompt → Action

User intent triggers system operations.

> "Run the daily grant scan."

OpenClaw executes the GrantOps pipeline and reports results.

### 3. Prompt → Code

OpenClaw can generate or modify system code.

> "Add a new widget to the finance dashboard for grant wins."

OpenClaw generates implementation suggestions and optionally prepares a patch.

### 4. Prompt → Workflow

A prompt triggers a multi-step automation pipeline.

> "Create a new marketing campaign for CUTMV."

OpenClaw may:
1. Generate creative angles
2. Produce ad scripts
3. Render assets
4. Prepare campaigns
5. Request approval before launch

---

## Universal Conversation Interface

Every interface must support the same prompt-first behavior.

### Telegram

Telegram is the mobile command layer.

Users say things like:
- "Check the cluster."
- "Generate ad scripts for CUTMV."
- "Apply for the top three grants."

OpenClaw interprets intent and responds conversationally.

Telegram messages may include:
- Action summaries
- Approval cards
- Progress updates
- Results

### Command Center UI

The Command Center always includes a chat console.

Users can:
- Ask questions
- Initiate actions
- Review system activity

> "Show me today's priority tasks."

> "Start the marketing automation loop."

The UI translates prompts into actions using the OpenClaw orchestration engine.

### Notion

Notion acts as a knowledge and planning interface, but prompts can also
originate here.

A Notion block might say:

> "Run weekly grant scan."

OpenClaw detects this instruction and executes it.
Results are written back into the relevant Notion database.

---

## Intent Interpretation Layer

To support prompt-first operation, OpenClaw must interpret user intent.
This layer performs three tasks:

### 1. Intent Classification

Determine what the user wants.

| Intent Category | Examples |
|----------------|----------|
| `information` | "What grants are available?" / "Show pipeline health" |
| `system_health` | "Check the cluster" / "Is the M1 online?" |
| `workflow_execute` | "Run the grant scan" / "Launch ad campaign" |
| `content_generate` | "Write three ad hooks" / "Draft a grant narrative" |
| `approval_decision` | "Approve the submission" / "Reject this campaign" |
| `analysis` | "Why did ads underperform?" / "Compare last two weeks" |
| `configuration` | "Enable GrantOps" / "Change the scan schedule" |

### 2. System Mapping

Map the request to internal capabilities.

| User Prompt | System Mapping |
|-------------|---------------|
| "Find grants for Full Digital" | `fulldigital-finance` → GrantOps Discovery Pipeline |
| "Check cluster health" | `fulldigital-ops` → `scripts/healthcheck.sh` |
| "Generate ad scripts for CUTMV" | `cutmv-growth` → Creative Engine (Remotion JSON) |
| "Show today's pipeline" | `fulldigital-sales` → GHL Pipeline Query |
| "Approve the grant submission" | `fulldigital-finance` → GrantOps Submitter → confirm |

### 3. Action Planning

OpenClaw builds a small execution plan before acting.

Example for "Find grants for Full Digital":
1. Query grant APIs (Candid, Grants.gov)
2. Filter by eligibility criteria
3. Score opportunities (fit + effort)
4. Write results to Notion
5. Send Telegram summary with top opportunities

---

## Safety and Approval

Prompt-first operation must always include guardrails.

OpenClaw automatically detects when human approval is required:

| Action Type | Approval Required |
|-------------|-------------------|
| Launching ads | Yes |
| Increasing ad budgets | Yes |
| Submitting grant applications | Yes |
| Deleting data | Yes |
| Infrastructure changes | Yes |
| Sending client-facing messages | Yes |
| Reading data / generating reports | No |
| Content drafting (not sending) | No |
| Health checks | No |

When approval is needed, OpenClaw responds like:

> "I can proceed with this action, but it requires approval.
> Would you like me to continue?"

Telegram approval cards include:
- Action type
- Estimated impact
- Reason for recommendation
- Rollback plan

---

## Plain English System Language

OpenClaw always responds in human language, not technical language.

### Bad (technical)
> "Executing pipeline grant_discovery_v2 with params {source: candid, threshold: 0.7}."

### Good (human)
> "Scanning grant databases for opportunities relevant to Full Digital.
> I'll filter for arts and creative industry grants with strong fit scores."

### Bad (technical)
> "Job job_cutmv_remotion_json_a1b2c3d4 completed. Exit code 0. Output: ~/cluster/results/."

### Good (human)
> "Your CUTMV ad is ready! I rendered a 30-second Remotion piece using the new hook.
> Want me to send it for review?"

---

## System Awareness

OpenClaw maintains internal knowledge of:

| Domain | What It Knows |
|--------|---------------|
| Cluster | M4 = Gateway, M1 = Inference, i7 = Utility; IPs, health status |
| Brands | Full Digital (agency) and CUTMV (SaaS) are separate brands |
| Storage | M4 hosts shared storage at ~/cluster; code lives at ~/openclaw |
| Pipelines | Marketing, finance, creative generation, fulfillment |
| Integrations | GHL, Stripe, Trello, ManyChat, Notion, PostHog, Candid |
| Models | Qwen 3.5 on M1 (primary), M4 (fallback), Claude API (escalation) |
| Safety | DRY_RUN defaults, approval requirements, kill switch |

This awareness allows OpenClaw to interpret prompts accurately and infer
context without requiring users to be explicit about system details.

---

## Prompt Context Awareness

OpenClaw automatically infers context.

**Ambiguous prompt:**
> "Generate three ad scripts."

**System asks:**
> "For Full Digital or CUTMV?"

**Or infers** the brand based on:
- Which Telegram channel the message came from
- Recent conversation context
- The agent that's currently active

---

## Continuous Dialogue

OpenClaw operates like a collaborator, not a command tool.

It should:
- Ask clarifying questions when intent is ambiguous
- Propose next steps after completing an action
- Explain its reasoning when making decisions
- Summarize outcomes concisely

Example:
> "I found 6 potential grants for Full Digital.
> Three appear highly relevant — two arts council grants and one SBA program.
> Would you like me to prepare draft applications for the top three?"

---

## What This Enables

With prompt-first architecture, OpenClaw becomes:

- An **AI operating system** for the business
- A **conversational automation engine** that understands context
- A **business collaborator** that proposes, executes, and explains

Instead of:
```
make cluster-start && python -m packages.grantops.scanner --source candid
```

The user says:
> "Let's find some grants for Full Digital today."

And OpenClaw figures out the rest.
