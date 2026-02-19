# AI Safety Fund - AI Agent Evaluation and Cybersecurity

- **Funder:** [AI Safety Fund](https://aisfund.org/funding-opportunities/) (Frontier Model Forum)
- **Program track:** AI Agent Evaluation and Cybersecurity
- **Status (as of February 19, 2026):** no open opportunities listed; prior rounds closed on January 31, 2025
- **Updates:** [aisfund.org/contact-us](https://aisfund.org/contact-us/)
- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented.

---

## Placeholders (fill or mark TBD before submission)

- **[Host organization]:** TBD
- **[PI and contributors]:** TBD
- **[Budget]:** TBD
- **[Timeline]:** TBD

---

## Project title

ConsentGuard for OpenClaw: Consent-Gated Tool Authorization, Containment, and Evaluation

---

## Summary

We propose implementing ConsentGuard, an authorization and containment layer for OpenClaw that enforces explicit consent before high-risk tool execution and emits an auditable decision trail. OpenClaw already provides strong primitives (gateway auth, tool allow/deny policy, exec approvals, and session routing), but it does not currently provide a single consent abstraction across all high-risk tool paths. ConsentGuard adds that abstraction through single-use consent tokens, context binding, revocation, and containment.

The implementation is grounded in real OpenClaw execution paths:

- HTTP tool invocation in `src/gateway/tools-invoke-http.ts`
- Node invocation and forwarding in `src/gateway/server-methods/nodes.ts`
- Node host command execution in `src/node-host/invoke.ts`

The goal is to produce reusable cybersecurity controls and an open evaluation suite for agent infrastructure.

---

## Why this fits AISF

- **Agent cybersecurity:** adds hard authorization controls around agent-triggered actions.
- **Agent evaluation:** defines measurable pass/fail properties for tool authorization and containment.
- **Open infrastructure impact:** OpenClaw is a multi-channel open-source agent platform, so improvements transfer to a broad deployment surface.

---

## Technical objectives

1. Implement a consent service with `issue`, `consume`, `revoke`, and append-only audit records.
2. Enforce single-use semantics and context binding (tool, session, channel/provider context, argument fingerprint).
3. Integrate at all invoke choke points so gated tools cannot bypass consent checks.
4. Add containment controls (anomaly scoring, quarantine mode, emergency revoke).
5. Publish an evaluation harness and reference results.

---

## OpenClaw-grounded threat and evaluation scenarios

| ID  | Scenario                                                     | Real OpenClaw surface                         | Expected control                                                              |
| --- | ------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Untrusted hook or scraped content attempts command execution | Hook payload to agent turn, then `exec`       | Consent required + trust policy block                                         |
| 2   | Shared DM context misuse in default scope                    | `dmScope=main` route behavior                 | Session isolation policy (`per-peer` or `per-channel-peer`) + context binding |
| 3   | Cross-session command injection                              | `sessions_send` and `sessions_spawn`          | Explicit consent and per-session authorization                                |
| 4   | Persistent automation abuse                                  | `cron` add/update/run actions                 | Separate consent for schedule mutation and execution actions                  |
| 5   | Sensitive file exfiltration chain                            | `read` plus `message` send                    | Path-aware policy and per-tool single-use tokens                              |
| 6   | Parallel replay/race attempts                                | Concurrent calls with same token              | Atomic consume, replay denial, WAL event                                      |
| 7   | Node-host escalation path                                    | `node.invoke` -> `system.run`                 | Consent check before invoke plus existing exec approvals                      |
| 8   | Channel re-auth misuse                                       | `whatsapp_login` and similar owner-only tools | Owner gating plus consent token requirement                                   |

Success metric: each scenario maps to explicit expected controls and regression tests.

---

## Methodology

- **Integration strategy:** add consent checks before high-risk tool execution in both HTTP and node invoke paths.
- **Policy model:** risk tiers plus tool policy overlays; keep final deny/allow decision deterministic.
- **Audit model:** every issue/consume/deny/revoke writes a structured WAL event with correlation IDs.
- **Containment model:** threshold-driven quarantine and gateway-wide emergency revoke.
- **Evaluation model:** scenario-based tests that assert outcomes and emitted audit events.

---

## Deployment model

- **Default:** in-process middleware in gateway and node host invoke paths.
- **Optional:** out-of-process consent service mode for higher-assurance deployments.
  - Benefits: process isolation and independent scaling.
  - Tradeoff: added latency and strict no-bypass guarantees needed across all callers.

---

## Deliverables

- ConsentGuard reference implementation for OpenClaw.
- Security-focused docs for configuration and operations.
- Structured WAL schema and example forensic workflows.
- Evaluation suite with reproducible scenarios and expected results.
- Public report summarizing measured security improvements.

---

## Team and timeline

- **Duration:** 12 months
- **Team placeholders:** `[PI]`, `[security engineer]`, `[OpenClaw integration engineer]`, `[evaluation lead]`
- **Milestones:**
  - **M1:** design and threat model
  - **M2:** core consent engine and integration
  - **M3:** containment and evaluation suite
  - **M4:** public documentation and adoption package

---

## Budget outline

- Personnel
- CI and infrastructure for test execution
- Community dissemination and adoption support

---

## Submission note

When AISF opens a new round, adapt this draft to the current form fields and limits, and re-check funder language before submission.
