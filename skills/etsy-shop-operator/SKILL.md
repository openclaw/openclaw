---
name: etsy-shop-operator
description: Plan or operate an Etsy shop with product, listing, ads, operations, competitor research, and approval-gated multi-agent workflows.
---

# Etsy Shop Operator

Use this skill to turn a broad Etsy growth request from Telegram or any other channel into an executable operating loop with clear artifacts, delegated research, and explicit approval gates.

## Operating Rules

- Treat revenue goals as targets for planning, not promises. Do not guarantee sales, ranking, ad performance, or marketplace outcomes.
- Preserve the seller account. Do not publish listings, edit live listings, change prices, issue refunds, message customers, or contact suppliers without explicit approval or a standing order that names the allowed routine action and limit. Do not buy ads, order inventory, or spend money without explicit per-action approval.
- Do not form legal entities, sign contracts, hire people, or make tax/legal claims. Draft the plan and approval package instead.
- Follow Etsy policies, ad platform policies, IP law, and consumer protection rules. Do not copy competitor listings, images, trademarks, reviews, or product claims.
- Do not create fake reviews, fake scarcity, deceptive claims, search-rank manipulation, spam, or harassment of competitors, buyers, or sellers.
- Use only lawful, ordinary access to public data. Do not bypass logins, rate limits, anti-bot systems, robots directives, or marketplace access controls.
- Keep credentials, customer data, order details, and financial data out of logs and public artifacts.
- If the user says not to ask for approval, that does not override the gates above. Draft and queue external-facing work for approval, including exactly what approval would authorize.
- Use internal sub-agents, TaskFlow, and durable workflow artifacts for coordination when available, but do not use email, marketplace messages, ads, or other external channels to contact people or spend money without approval.

## Telegram Intake

When the request arrives from Telegram or another chat channel:

- Convert "do everything," "use however many agents," or "do not ask for approval" into written operating authority with explicit limits.
- Start from the supplied shop URL and public marketplace data. Do not store chat ids, phone numbers, customer data, or credentials in shop artifacts unless the user explicitly asks and the storage location is private.
- Treat extreme revenue targets as planning constraints to decompose into measurable workstreams, not as forecasts or promises.
- Complete the first concrete artifact before replying whenever tools are available; otherwise, reply with the exact artifact path you will create first, the next safe action, and any approval needed for live account changes.

## First Pass

Create or update these workspace artifacts before acting:

- `etsy/shop-brief.md`: shop URL, brand promise, target buyers, constraints, margin assumptions, fulfillment capacity, approval limits.
- `etsy/operating-model.md`: workstreams, agent roles, weekly cadence, KPIs, budget boundaries, and escalation rules.
- `etsy/audit.md`: current shop readout, listing gaps, policy risks, analytics gaps, and first opportunities.
- `etsy/product-backlog.csv`: product concept, buyer problem, differentiator, production needs, margin hypothesis, evidence, status.
- `etsy/listing-drafts/`: one file per listing package with title, photos needed, tags, attributes, description, FAQs, and launch checklist.
- `etsy/approval-queue.md`: live account changes, customer replies, ad spend, purchases, supplier outreach, and other external actions awaiting explicit approval.
- `etsy/experiment-log.csv`: date, hypothesis, change, metric, result, next action.
- `etsy/workflow.md`: current goal, durable flow or task ids when available, active child work, approval gates, and next safe action.

If inputs are missing, proceed with public data and clearly mark assumptions. Ask only for blockers that prevent the next safe artifact.

## Company Operating Model

Build the shop program as workstreams, not a single vague task:

- Strategy: goals, buyer segments, positioning, margin model, and quarterly bets.
- Product: concepts, sourcing or production needs, quality checks, differentiation, and launch queue.
- Listings: SEO, copy, visual requirements, pricing hypotheses, and policy checks.
- Growth: competitor pattern analysis, ad experiments, promotions, conversion review, and budget proposals.
- Operations: fulfillment, customer-service drafts, review monitoring, returns, and exception handling.
- Finance: fee estimates, gross margin, break-even ad cost, cash needs, and risk notes.

Each workstream owns draft artifacts and metrics. Live account changes, customer contact, spend, purchases, hiring, and legal/tax actions remain approval-gated.

## Workflow Setup

- For multi-step or recurring work, use OpenClaw TaskFlow when available so progress, waits, child tasks, and cancellation survive restarts.
- If TaskFlow is unavailable, maintain `etsy/workflow.md` as the durable state record and update it after each execute-verify-report cycle.
- If an internal agent-mail or inbox primitive is available, use it only for coordination between agents and summarize decisions back into `etsy/workflow.md`. Treat ordinary email, marketplace messages, supplier outreach, and customer contact as external actions that require approval.
- Convert standing orders into a written program before treating them as durable authority. Name the scope, trigger, approved routine actions, approval gates, escalation rules, and any budget or data boundaries.
- Standing orders can authorize research, drafting, analysis, file creation, internal task coordination, and named routine live actions with limits. They never authorize ad spend, purchases, hiring, contracts, or legal/tax commitments.

## End-to-End Loop

1. Audit the shop, products, buyers, competitors, prices, shipping promises, reviews, and visual consistency.
2. Build a product backlog from buyer problems, search demand, competitor weaknesses, production feasibility, and margin.
3. For each candidate, create a listing package: product angle, title, tags, attributes, description, photo shot list, mockup needs, pricing hypothesis, fulfillment notes, and policy checks.
4. Prepare launch changes as drafts or patches and add each external action to `etsy/approval-queue.md`. Stop before publishing, messaging, buying, or spending.
5. After approval, run small experiments with named success metrics and a rollback plan.
6. Review results weekly. Promote winners, kill weak tests, and update the backlog.

## Delegation Pattern

When `sessions_spawn` is available, split independent work into focused sub-agents and keep the parent responsible for synthesis:

- Market researcher: search demand, trend language, buyer problems, seasonal timing.
- Competitor analyst: price bands, positioning gaps, listing patterns, review complaints.
- Product strategist: concepts, differentiation, bundles, personalization, margin risks.
- Listing copywriter: titles, tags, descriptions, FAQs, and conversion objections.
- Creative director: photo requirements, mockup plan, visual consistency, brand system.
- Ads analyst: campaign draft, budget guardrails, measurement plan, stop-loss thresholds.
- Operations analyst: fulfillment, inventory, customer service macros, return risks.

Use isolated context for broad research. Prefer sandboxed children for web-heavy work when available. Use forked context only when the sub-agent needs current private shop assumptions.

## Etsy Listing Package

Each listing draft should include:

- Buyer: who wants this and why now.
- Product: what is sold, variants, personalization, production inputs, delivery promise.
- Differentiator: one clear reason to choose this over alternatives.
- SEO: title, 13 tags, attributes, category, occasion/recipient if applicable.
- Conversion: first photo goal, photo sequence, description hook, objections answered, FAQ.
- Economics: price hypothesis, fees/shipping estimate, COGS, gross margin, break-even ad cost.
- Risk checks: IP/trademark risk, prohibited claims, copied competitor language, production feasibility.
- Approval checklist: exactly what will change live if approved.

## Competitor Research

Capture patterns, not copies:

- Note recurring buyer language, price bands, shipping promises, personalization options, review complaints, and visual conventions.
- Turn weaknesses into original product or listing improvements.
- Never reuse competitor photos, listing text, shop names, trademarked terms, review text, or exact bundle structure as-is.

## Advertising

Draft campaigns as experiments:

- Hypothesis, audience/search terms, listing set, budget cap, stop-loss threshold, success metric, review date.
- No ad spend or budget changes without explicit approval.
- Prefer small tests that can teach quickly over broad uncapped campaigns.

## Customer And Operations Work

- Draft customer replies; send only when approved or covered by a standing order.
- Escalate complaints, refund/cancellation requests, legal threats, safety issues, custom-order ambiguity, and anything involving personal data.
- For fulfillment, produce checklists, templates, and exception queues before changing live processes.

## Reporting

Use an executive summary with:

- What changed or was drafted.
- Evidence used.
- Metrics affected.
- Decisions needed.
- Next safe action.

When the user asks for "everything," complete the next concrete artifact first, verify it exists, and report the path plus the next approval or experiment.
