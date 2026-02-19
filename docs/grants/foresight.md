# Foresight Institute — AI Safety Grant

- **Funder:** [Foresight Institute](https://foresight.org/ai-safety/) — AI Safety: Security / Neuro / Crypto / Multipolar
- **Funding:** ~$4.5–5.5M/year total; individual grants ~$10K–$300K+
- **Deadlines:** Quarterly — March 31, June 30, September 30, December 31. Decisions within ~8 weeks.
- **Apply:** [Airtable application form](https://airtable.com/appyVXc5SMPAvIKpP/pagnX5sphV5gw8CVF/form)
- **Focus areas (relevant):** Security technologies for AI systems (e.g. formal verification, red-teaming); Safe multi-agent scenarios and AI agent coordination.
- **Eligibility:** Individuals, teams; nonprofit and for-profit.
- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented.

---

## Placeholders (fill or mark TBD before submission)

- **[Host organization]:** TBD (if required by program)
- **[PI and contributors]:** David Weatherspoon (lead); TBD others
- **[Budget]:** TBD (e.g. $75K–$150K; scale as needed)
- **[Timeline]:** 6–12 months; TBD milestones per form

---

## Project title

ConsentGuard: Formally-Specified Consent and Containment for AI Agents — Implementation and Red-Team Evaluation

---

## Project description (for form — adapt length to field limits)

ConsentGuard adds a consent-gated security layer to the OpenClaw AI agent platform (project lead: **David Weatherspoon** — [Medium](https://medium.com/@reconsumeralization), [GitHub](https://github.com/reconsumeralization)) so that no high-risk tool (shell, filesystem, skill install, cron, etc.) runs without a valid consent token. Tokens are **single-use** (P2) and **context-bound** (P3): tool, trust tier, and session are in the context hash, so tokens cannot be laundered across channels or escalated from low-trust sources (email, Moltbook) to privileged tools. We tag input by source—owner_paired, trusted_peer, group_mention, email_inbox, moltbook_feed, web_scraped—and allow tools only per tier; prompt injection from untrusted content is blocked before the agent can act. **Containment** logic caps autonomous ops per window (C3), maintains an anomaly score (tier violation, double-spend, context mismatch), and triggers quarantine plus cascade revocation (C4–C5). Every issue, consume, deny, and revoke is written to a **write-ahead log (WAL)** for audit (P4). The design is specified with **formal properties** (P1–P5, C3–C5) and is intended to be expressed in **TLA+** for model-checking. We implement ConsentGuard in the OpenClaw gateway invoke path and provide a **structured red-team suite**: eight attack scenarios (email injection, ClawHub supply-chain skill, Moltbook hijack, session bleed, credential exfil, TOCTOU parallel tool calls, heartbeat persistence, skill self-write) with payloads, expected blocks, and regression tests. Deliverables: open-source implementation, WAL format spec, red-team scenario suite and evaluation report, and documentation for adoption by other agent systems. This aligns with Foresight’s focus on **security technologies for AI** (formal verification, defensible guarantees) and **safe multi-agent** coordination (per-session and per-channel isolation, no cross-tier abuse). The project’s **reconsumeralization** framing—re-centering explicit, revocable consent in agent tool execution—ensures consent is not assumed but re-established and logged per action, strengthening both security and user agency.

---

## Relevance to Foresight focus areas

- **Security technologies for AI systems:** ConsentGuard is a runtime security layer (authorization, taint tracking, containment) with **formal properties** (single-use, context binding, revocation immediacy, blast-radius cap). We aim for a **TLA+ specification** and model-checked invariants—e.g. “no execution without consent,” “no double consume,” “revocation invalidates token”—aligning with formal verification and defensible guarantees. The red-team suite provides **automated red-teaming** (structured attacks and expected defences) that can be run in CI.
- **Safe multi-agent / agent coordination:** OpenClaw is inherently **multi-channel and multi-session** (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, email, Moltbook, etc.). ConsentGuard enforces **per-session** and **per-channel-peer** isolation (P11) and prevents cross-session and cross-tier abuse (session bleed, token laundering). Containment (C3–C5) limits blast radius across channels when anomaly is detected. This directly addresses safe multi-agent scenarios where multiple sources (owners, peers, groups, untrusted feeds) interact with the same agent infrastructure.

---

## Red-team / evaluation methodology

| Scenario              | Attack vector                            | Trust tier         | Property that blocks              | Red-team deliverable                  |
| --------------------- | ---------------------------------------- | ------------------ | --------------------------------- | ------------------------------------- |
| Email injection       | Hidden instructions in email body        | email_inbox (T3)   | P1 + tier (no tools at T3)        | Payload + WAL assertion + test        |
| ClawHub supply chain  | Malicious SKILL.md with undeclared tools | owner_paired       | Bundle/manifest verification      | Manifest check + BUNDLE_MISMATCH test |
| Moltbook hijack       | Feed post with agent override            | moltbook_feed (T3) | P1 + tier; C4 quarantine          | Payload + anomaly test                |
| Session bleed         | Group member requests fs_write           | group_mention (T2) | P11 + tier (T2 ≠ fs_write)        | Session-id + tier test                |
| Exfil                 | filesystem_read then channel_send        | trusted_peer       | P2/P3 (separate tokens; no reuse) | Two-call test + ctxHash check         |
| TOCTOU                | Parallel fs_write with one token         | owner_paired       | P2 (atomic consume; one wins)     | Parallel-invoke test                  |
| Heartbeat persistence | cron_schedule then repeated exec         | trusted_peer       | Per-execution token; TTL          | Cron registration vs exec test        |
| Skill self-write      | skill_selfwrite + hidden cron            | owner_paired       | Content hash; separate cron token | Content-hash + cron test              |

Success: all eight scenarios **blocked or mitigated** with correct property attribution; regression suite in CI; short evaluation report for the Foresight community.

---

## Expected outcomes

- **Working ConsentGuard integration** in OpenClaw (gateway or node-host path) with config, WAL, and containment.
- **Documented safety properties** (P1–P5, C3–C5) and, if scope allows, a **TLA+ spec** and model-checking results (invariants: no double consume, no execution without consent, revocation works, containment triggers).
- **Public red-team suite**: eight scenarios with payloads, expected blocks, and automated tests; **evaluation report** (block rate, property coverage).
- **Written report and/or blog post** for the Foresight community; **open-source release** (code, WAL format, docs) under MIT or compatible license.

---

## Budget and timeline

- **Duration:** 6–12 months (specify in form). Recommended: 9–12 months to include implementation, red-team suite, and optional TLA+ work.
- **Amount requested:** [e.g. $75K–$150K] — personnel (lead developer ± part-time formal methods / red-team), minimal infra (CI), dissemination (blog post, report). Scale up to $200K+ if including dedicated TLA+ and multi-month evaluation.
- **Milestones:**
  - **Months 1–2:** Spec + WAL schema; property doc; red-team scenario list.
  - **Months 3–5:** Core implementation + gateway integration; WAL writer; config and tiers.
  - **Months 6–7:** Red-team suite (eight scenarios, tests, evaluation report draft).
  - **Months 8–9:** Optional TLA+ spec and model-check; polish report.
  - **Months 10–12:** Release, docs, Foresight report/blog, outreach.

---

## How to submit

Go to [foresight.org/ai-safety](https://foresight.org/ai-safety/) and use the Airtable form. Paste or adapt the **Project description** and **Relevance** sections into the application. Attach or link to a short doc containing the red-team table and outcomes if the form allows. For “expected outcomes,” use the bullet list above; for “budget,” use the outline with your chosen figures.
