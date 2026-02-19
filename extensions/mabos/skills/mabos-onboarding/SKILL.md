# MABOS Onboarding — Guided Business Setup

A structured 5-phase conversational pipeline that onboards a new business into MABOS. Each phase has clear inputs, tool calls, and a gate before advancing.

## Phase 1: Discovery

Ask the stakeholder these questions one at a time. Adapt phrasing conversationally, but collect all fields.

1. **What is your business called?** → `name`, `legal_name`
2. **What type of business is it?** → `type` (ecommerce | saas | consulting | marketplace | retail | other)
3. **What does your business do?** → `description`, `products_services`
4. **Who are your customers?** → `customer_segments`, `target_market`
5. **How do you make money?** → `revenue_streams`, `revenue_model`
6. **What's your value proposition?** → `value_propositions`
7. **What technology do you use?** → `technology_stack`
8. **What stage are you at?** → `stage` (idea | mvp | growth | scale | mature)
9. **What are your top 3 goals?** → `stakeholder_goals` (each with priority 0-1 and type hard/soft)
10. **Any constraints?** → `constraints` (budget, timeline, regulatory)
11. **Where are you registered?** → `jurisdiction`

### Gate

Summarize all collected data back to the stakeholder. Ask for confirmation before proceeding.

```
onboarding_progress(business_id, phase: "discovery", status: "completed")
```

## Phase 2: Architecture

Call these tools in sequence:

```
onboard_business(business_id, name, legal_name, type, description, value_propositions, customer_segments, revenue_streams, jurisdiction, stage)
```

```
togaf_generate(business_id, business_name, business_type, description, products_services, target_market, revenue_model, technology_stack, stage)
```

```
bmc_generate(business_id, value_propositions, customer_segments, revenue_streams, ...)
```

```
tropos_generate(business_id, stakeholder_goals, constraints)
```

```
onboarding_progress(business_id, phase: "architecture", status: "completed")
```

Tell the stakeholder what was generated: TOGAF architecture, Business Model Canvas, and Tropos goal model.

## Phase 3: Agent Activation

```
agent_spawn_domain(business_id, business_type)
```

```
desire_init_from_template(business_id)
```

```
onboarding_progress(business_id, phase: "agents", status: "completed")
```

Tell the stakeholder which agents were spawned and how their desires were initialized.

## Phase 4: Knowledge Graph

```
sbvr_sync_to_backend(business_id)
```

```
onboarding_progress(business_id, phase: "knowledge_graph", status: "completed")
```

If the backend is unavailable, tell the stakeholder the SBVR export was saved locally and can be synced later. Mark the phase as "skipped" with a note.

## Phase 5: Launch

Show the pipeline progress:

```
onboarding_progress(business_id, phase: "launch", status: "started", show_canvas: true)
```

Kick off the CEO's first reasoning cycle:

```
bdi_cycle(agent_id: "{business_id}/ceo", depth: "full")
```

Present the stakeholder dashboard:

```
present_dashboard(business_id)
```

```
onboarding_progress(business_id, phase: "launch", status: "completed")
```

## Recovery

- Each phase is independently retriable. Use `onboarding_progress(phase, status: "retry")`.
- `onboarding-progress.json` persists across sessions.
- If any tool fails, mark the phase as "failed" with details and continue to the next phase if possible.
- The stakeholder can resume from any phase by checking current progress with `onboarding_progress(business_id, phase, status: "started")`.

## Quick Start (Batch Mode)

For programmatic use without conversational flow:

```
onboard_business(business_id, ..., orchestrate: true)
```

This runs all phases automatically in a single call.

## Domain-Specific Agents

| Business Type | Extra Agents                                            |
| ------------- | ------------------------------------------------------- |
| E-commerce    | Inventory Manager, Fulfillment Manager, Product Manager |
| SaaS          | DevOps, Product Manager, Customer Success               |
| Consulting    | Engagement Manager, Business Development                |
| Marketplace   | Supply Manager, Demand Manager, Trust & Safety          |
| Retail        | Store Manager, Merchandiser                             |
