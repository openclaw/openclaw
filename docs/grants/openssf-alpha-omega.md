# OpenSSF Alpha-Omega — Grant Application

- **Funder:** [OpenSSF Alpha-Omega](https://openssf.org/community/alpha-omega/) — security for critical open source software (funded by AWS, Google, Microsoft)
- **Apply:** [Grant submission form](https://share.hsforms.com/1sZmUUNQLQ0SwlMhrcOs7ww4tvhy). If aligned, you are contacted to develop a Proposal/SOW.
- **Eligibility:** Standalone projects, foundations covering many projects, core ecosystem services (informed by OpenSSF Securing Critical Projects working group).
- **Expectations:** Monthly public reports; participation in monthly strategy roundtables; beginning/middle/end blog posts on the work.
- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented.

---

## Placeholders (fill or mark TBD before submission)

- **[Host organization]:** Specify OpenClaw project / foundation / managing organisation that can receive funds and report publicly.
- **[PI and contributors]:** David Weatherspoon (lead); TBD others.
- **[Budget]:** TBD per program.
- **[Timeline]:** TBD milestones.

---

## 1. Project / organisation identification

- **Project:** OpenClaw — <https://github.com/openclaw/openclaw>. Multi-channel AI gateway and agent platform; license **MIT**. The project has significant GitHub adoption and a broad ecosystem (gateway, Pi agent, sessions, many channels, ClawHub/skills).
- **Grant focus:** **ConsentGuard** — a security and consent layer that hardens OpenClaw by gating high-risk tool execution on consent tokens, trust tiers (taint by channel/source), containment (anomaly, quarantine, cascade revoke), and a write-ahead log (WAL) for every decision. Project lead: **David Weatherspoon** (Medium: [@reconsumeralization](https://medium.com/@reconsumeralization), GitHub: [reconsumeralization](https://github.com/reconsumeralization)), whose **reconsumeralization** work—re-establishing explicit, revocable consent in agent–system interactions—guides the design. The grant would go to [specify: OpenClaw project / foundation / managing organisation that can receive funds and report publicly].
- **Open source license:** MIT (OpenClaw and ConsentGuard components will remain MIT or compatible).

---

## 2. Current state: criticality and security posture

**Criticality:** OpenClaw is a widely used open-source AI agent platform with substantial GitHub presence and adoption. It integrates with many messaging and communication channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, email, Moltbook, etc.) and runs agent loops that can execute **shell**, **filesystem**, **browser**, **skill install**, and **cron** tools. As such it is part of the **supply chain and operational stack** for many deployments; compromise or misuse—prompt injection, credential exfiltration, supply-chain attacks via third-party skills, session bleed—could affect many users and downstream systems. Improving its security posture directly protects deployers and end users who rely on the ecosystem.

**Current security posture:** The project already has **gateway authentication**, **tool allow/deny lists** (`gateway.tools.deny`, default deny for sessions_spawn, sessions_send, whatsapp_login, etc.), **exec approval** (socket-based, human-in-the-loop for shell), and **sandboxing** options. What is **missing** is a **unified consent and audit layer** that: (1) requires **explicit consent (token)** before high-risk tool execution, with single-use and context binding so tokens cannot be reused or laundered; (2) tracks **trust by source/channel** so untrusted content (email, Moltbook, web) cannot authorize privileged tools; (3) enforces **containment** (anomaly scoring, quarantine, cascade revoke) to limit blast radius; (4) writes **every decision** to an append-only WAL for audit and forensics. ConsentGuard is designed to fill this gap **without replacing** existing mechanisms; it composes with gateway auth and exec approval.

**Challenges:** (1) Implementing a **single choke point** in the invoke path so all gated tools go through ConsentGuard (both HTTP `/tools/invoke` and WebSocket `node.invoke`). (2) Defining a **stable WAL format** and optional tooling for audit and analysis. (3) Documenting and **testing attack scenarios** (email injection, supply chain, Moltbook, session bleed, exfil, TOCTOU, heartbeat, skill self-write) with expected blocks and regression tests. (4) **Maintaining compatibility** with existing config and extensions so adoption is straightforward.

---

## 3. Desired outcomes and success metrics

**Outcomes:**

- ConsentGuard **integrated** into the OpenClaw gateway (or node-host) tool-invocation path for high-risk tools (shell*exec, filesystem*\*, skill_install, skill_selfwrite, cron_schedule, etc.).
- Every gated tool call **requires** a valid, single-use, context-bound consent token; tier violations and containment events are **logged** to the WAL.
- A **public WAL format** specification and optional reader/tooling for audit and forensics.
- **Documented attack scenarios** (eight: email injection, ClawHub supply chain, Moltbook hijack, session bleed, exfil, TOCTOU, heartbeat persistence, skill self-write) with expected blocks (which property) and **regression tests** in CI.
- **Documentation** for operators (config, trust tiers, containment) and for other projects that want to adopt the consent-gate pattern (integration guide, adoption guide).

**Why these outcomes:** They directly improve **security** (no unauthorized tool execution, full audit trail, supply-chain verification for skills) and **safety** (containment, blast-radius cap). Success is **measurable** by:

- **All gated tools** pass through ConsentGuard in CI (no bypass).
- **Attack-scenario tests** pass (blocked or mitigated with correct property attribution).
- **WAL entries** produced for every issue/consume/deny/revoke in tests and documented in format spec.
- **Monthly public reports** and beginning/middle/end **blog posts** as required by Alpha-Omega, demonstrating progress and security outcomes.

**Direct benefit to end-users:** Operators get a clear **consent and audit story** (“no high-risk tool without consent,” “every decision logged”); deployments can demonstrate accountability and support **incident response** using the WAL; other open-source agent projects can **reuse** the design and WAL format to harden their own ecosystems.

---

## 4. How we will achieve these outcomes

- **Specification and design (Months 1–2):** Finalise ConsentGuard spec (tokens, tiers, containment parameters, WAL schema) and document properties (P1–P5, C3–C5). Publish a short design doc and threat-model summary.
- **Implementation (Months 3–5):** Implement core ConsentGuard library and integrate into the gateway (or node-host) invoke path; add config for trust tiers and containment (`openclaw.json`); implement WAL writer and optional reader/tooling. Ensure single choke point for all gated tools.
- **Supply-chain and skills (Months 4–5):** Integrate with skill/skill_install flow (manifest verification, bundle hash) where applicable; document BUNDLE_MISMATCH and re-confirmation for critical tools.
- **Testing and scenarios (Months 5–7):** Add eight attack-scenario tests and regression suite; document each scenario (payload, expected block, code reference). Run in CI on every change.
- **Documentation and release (Months 6–8):** Integration guide, operator guide, WAL format doc, adoption guide; release in OpenClaw repo or documented extension. Publish beginning and middle blog posts.
- **Reporting and community (ongoing):** Monthly public reports; participation in Alpha-Omega monthly strategy roundtables; end-of-grant blog post. Respond to community and Alpha-Omega feedback.

Work can start promptly upon grant agreement. Lead: **David Weatherspoon** ([reconsumeralization](https://github.com/reconsumeralization)). [Specify whether hiring or using existing maintainers/contributors; indicate capacity for monthly reporting and roundtables.] The reconsumeralization framing keeps consent and audit at the centre of all deliverables (re-consent per action, WAL, revocation).

---

## 5. Paste / adapt into the form

When filling the [Alpha-Omega grant form](https://share.hsforms.com/1sZmUUNQLQ0SwlMhrcOs7ww4tvhy), use sections 1–4 above in the corresponding fields (project identification, current state, desired outcomes, approach). Keep language concise where character limits apply. After submission, the A-O team may contact you to develop a formal Proposal/SOW; this document can serve as the basis for that SOW.
