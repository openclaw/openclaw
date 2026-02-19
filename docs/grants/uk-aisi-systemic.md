# UK AI Safety Institute - Systemic AI Safety Fast Grants

- **Funder:** [UK AISI](https://www.aisi.gov.uk/grants)
- **Program:** Systemic AI Safety Fast Grants
- **Status (as of February 19, 2026):** "We are not currently accepting applications" per the [grants page](https://www.aisi.gov.uk/grants)
- **Eligibility model:** UK host organization required; international collaborators allowed
- **Contact:** <AISIgrants@dsit.gov.uk>
- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented.

---

## Placeholders (fill or mark TBD before submission)

- **[Host organization]:** UK host required; TBD
- **[PI and contributors]:** TBD
- **[Budget]:** TBD
- **[Timeline]:** TBD

---

## Project title

Systemic Safety Controls for Open-Source Agent Infrastructure: ConsentGuard for OpenClaw

---

## Summary

This project targets systemic AI safety at the infrastructure layer rather than model behavior alone. We propose ConsentGuard for OpenClaw, a policy and authorization layer that sits directly on tool invocation paths and enforces explicit consent, context binding, revocation, and containment for high-risk actions.

The work is systemic because it constrains what the deployment stack can execute, regardless of model output quality. The implementation focuses on gateway and node invoke boundaries, session routing, and cross-channel operation, producing controls that are deployable, auditable, and transferable to other agent platforms.

---

## Why this is systemic

- **Infrastructure scope:** controls attach to gateway and node execution boundaries, not prompt text alone.
- **Cross-channel scope:** protections apply across OpenClaw channels and plugin surfaces.
- **Session and identity scope:** protections integrate with session scoping rules (`main`, `per-peer`, `per-channel-peer`) and route context.
- **Operational scope:** outputs include concrete policy, logs, incident handling procedures, and measurable outcomes.

---

## OpenClaw technical grounding

- HTTP tool invocation and policy path: `src/gateway/tools-invoke-http.ts`
- Node invocation path: `src/gateway/server-methods/nodes.ts`
- Node host execution and local approval controls: `src/node-host/invoke.ts`
- HTTP high-risk default deny list: `src/security/dangerous-tools.ts`
- Session scope and route resolution: `src/routing/resolve-route.ts` and `src/routing/session-key.ts`

---

## Research questions

1. How can explicit consent be enforced at all high-risk invoke paths with minimal bypass risk?
2. Which containment parameters best reduce harm while preserving normal operator workflows?
3. What minimum interface is needed so other agent systems can adopt the same safety pattern?

---

## Proposed activities

1. **Specification and threat model**
   - Define consent lifecycle (`issue`, `consume`, `revoke`)
   - Define deterministic context binding inputs
   - Define WAL event schema and retention model
2. **Implementation**
   - Integrate checks into OpenClaw invoke choke points
   - Add single-use and replay protection
   - Add containment and emergency revoke paths
3. **Evaluation**
   - Build scenario-driven regression suite
   - Measure block/allow correctness and false positive rate
4. **Operationalization**
   - Produce deployment guides for in-process and optional external-service modes
   - Publish incident response playbook using WAL evidence

---

## Deployment architecture options

- **In-process mode (default):**
  - Lower latency
  - Easier rollout and testability
- **Separate service mode (optional):**
  - Stronger process boundary
  - Better isolation for high-assurance environments
  - Higher operational overhead and stricter no-bypass requirements

---

## Deliverables

- ConsentGuard reference implementation for OpenClaw
- Systemic safety design document
- WAL specification and analysis utilities
- Reproducible evaluation suite
- Adoption guide for other open-source agent infrastructures

---

## Team and host

- **UK host organization:** `[UK university, business, or civil society organization]`
- **Team placeholders:** `[PI]`, `[security lead]`, `[OpenClaw integration lead]`, `[evaluation lead]`
- **International collaborators:** `[names and roles]`

---

## Submission note

Use this draft when UK AISI reopens this program, and re-check all program terms and dates at submission time.
