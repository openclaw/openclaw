# NSF — Safety, Security, and Privacy of Open-Source Ecosystems (Safe-OSE)

- **Program:** [NSF 24-608 Safe-OSE](https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems/nsf24-608/solicitation)
- **Funding:** ~$15M total; up to ~10 awards of ~$1.5M each
- **Deadlines (check current solicitation):** Preliminary proposal — typically January (e.g. Jan 14, 5pm submitter local); Full proposal — by invitation only, typically April (e.g. Apr 22, 5pm submitter local)
- **Focus:** Safety, security, and/or privacy for **mature, established open-source ecosystems** with existing managing organisations. **Implementation-oriented** (not research-only).
- **Eligibility:** U.S. institutions; see solicitation for PI/co-PI and organisation rules.
- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented.

---

## Placeholders (fill or mark TBD before submission)

- **[Host organization]:** Identify U.S. managing organisation (e.g. university, 501(c)(3)) that can receive the award.
- **[PI and contributors]:** David Weatherspoon — PI; co-PIs/collaborators TBD.
- **[Budget]:** TBD per solicitation (personnel, travel, equipment, subawards).
- **[Timeline]:** Align milestones with preliminary (Jan) and full (Apr) proposal cycle; verify current solicitation dates.

---

## Project title (preliminary / full)

ConsentGuard: Security and Consent Layer for the OpenClaw Open-Source AI Agent Ecosystem — Supply-Chain and Tool-Execution Safety

---

## Project summary (1 page — for preliminary proposal)

**Ecosystem and criticality:** OpenClaw (<https://github.com/openclaw/openclaw>) is an open-source, multi-channel AI gateway and agent platform. This proposal is led by **David Weatherspoon (reconsumeralization)**, whose work on **reconsumeralization**—re-centering explicit, auditable consent in agent ecosystems—informs ConsentGuard’s design: every high-risk action requires re-established authorization and is logged and revocable. OpenClaw with substantial adoption and a large contributor base. Its ecosystem includes the core gateway (Node.js, WebSocket + HTTP), the Pi agent runtime (@openclaw/pi-agent-core), session management (main, per-peer, per-channel-peer), many channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage/BlueBubbles, Teams, Matrix, Zalo, WebChat, etc.), and a skill/plugin system (ClawHub, SKILL.md). High-risk tools—shell_exec, filesystem_read/write, browser_navigate, skill_install, skill_selfwrite, cron_schedule, sessions_spawn—are executable by the agent. The ecosystem is **mature and established** with a clear managing and development community; prompt injection, supply-chain compromise via third-party skills, and session bleed pose **concrete safety, security, and privacy risks** to deployments and downstream users.

**Problem:** The ecosystem currently lacks a **unified, auditable authorization layer** that: (1) requires **explicit consent** before high-risk tool execution; (2) tracks **trust by source/channel** (taint) so untrusted content (e.g. email, Moltbook, web-scraped) cannot authorize privileged tools; (3) **constrains autonomous persistence** (e.g. cron/heartbeat) and blast radius; (4) provides a **verifiable audit trail** (write-ahead log) for every decision. Third-party skills (ClawHub) and multi-tenant or multi-channel use amplify **supply-chain** and **isolation** risks. Existing controls (gateway auth, tool deny lists, exec approval) are valuable but do not provide consent-gated execution, taint tracking, or a single audit log for authorization decisions.

**Solution:** We propose implementing and maintaining **ConsentGuard** as a security and consent layer for the OpenClaw ecosystem: **token-based authorization** (single-use, context-bound so tokens cannot be laundered); **trust-tier enforcement** (owner_paired, trusted_peer, group_mention, email_inbox, moltbook_feed, etc.); **containment** (anomaly scoring, quarantine, cascade revoke, blast-radius cap); and a **write-ahead log (WAL)** for every issue/consume/deny/revoke. We will integrate ConsentGuard into the gateway/node-host tool-invocation path, define a **WAL format** and tooling for audit and forensics, implement **supply-chain controls** (skill manifest verification, bundle hash) for skill_install and skill_selfwrite, and document **attack scenarios** with expected blocks and regression tests. Outcomes improve **safety** (no unauthorized tool execution, containment of abuse), **security** (audit trail, supply-chain verification, single choke point), and **privacy** (session/channel isolation, minimal privilege per tier) for the ecosystem.

**Managing organisation:** [Identify the organisation that will receive the award—e.g. U.S. university, 501(c)(3), or other eligible entity that can partner with or represent the OpenClaw ecosystem for this grant. Safe-OSE requires a managing organisation for the ecosystem.]

**Team and approach:** **David Weatherspoon** — PI (Medium: [@reconsumeralization](https://medium.com/@reconsumeralization), GitHub: [reconsumeralization](https://github.com/reconsumeralization)); [co-PIs, collaborators; partnership with OpenClaw maintainers if applicable]. The PI’s reconsumeralization framework ensures the ecosystem layer prioritises re-consent, audit trail, and revocation as core safety and privacy outcomes. Implementation milestones: (1) ConsentGuard specification and WAL schema; (2) core library and gateway integration; (3) supply-chain and skill-verification integration; (4) attack-scenario suite and documentation; (5) release, operator guide, and community adoption support. We will use existing OpenClaw CI and release processes; no duplication of infrastructure.

**Broader impact:** The **design and WAL format** will be reusable by other open-source agent or automation ecosystems. We will publish specifications, integration guides, and evaluation scenarios to maximise adoption and safety impact beyond OpenClaw. The consent-gate pattern and trust-tier model are generalisable to any system where “who granted this action?” and “from what source?” must be auditable and enforceable.

---

## Mapping to Safe-OSE goals (safety, security, privacy)

| Safe-OSE dimension | ConsentGuard contribution                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Safety**         | No high-risk tool execution without consent; containment limits blast radius; anomaly triggers quarantine and revoke.                                       |
| **Security**       | Single choke point for gated tools; WAL for every decision (forensics, compliance); supply-chain verification for skills; no token laundering across tiers. |
| **Privacy**        | Session and channel isolation (per-channel-peer); minimal privilege per trust tier; audit trail supports data-access accountability.                        |

---

## Key words (for NSF systems)

Open-source software security; AI agent systems; consent and authorization; supply-chain security; audit trail; formal safety properties; ecosystem hardening; write-ahead log; trust tiers; containment.

---

## Full proposal outline (when invited)

1. **Introduction and motivation** — OpenClaw ecosystem (scale, channels, tools, skills), threat model (prompt injection, supply chain, session bleed, exfil, TOCTOU, persistence), gap (consent/audit/containment).
2. **ConsentGuard design** — Tokens (issue/consume/revoke), trust tiers, containment (anomaly, quarantine, cascade), WAL; properties P1–P5, C3–C5; supply-chain (manifest, bundle hash).
3. **Implementation plan** — Gateway integration (choke point), WAL format and tooling, skill/supply-chain checks, config and deployment; testing and regression (attack scenarios).
4. **Evaluation and metrics** — Attack-scenario suite (eight scenarios), success criteria (block rate, WAL completeness, property coverage); adoption and sustainability metrics (docs, downloads, deployments).
5. **Broader impact and dissemination** — Documentation (operator guide, integration guide, adoption guide); outreach; reuse by other ecosystems; education and workforce (if applicable).
6. **Project management** — Timeline, milestones, team roles, risk mitigation (e.g. gateway API stability, backward compatibility).
7. **Budget** — Personnel, travel, equipment (if any), subawards (if any); justify amounts relative to milestones.

---

## Where to submit

- **Preliminary:** Research.gov (or NSF-approved system); see [NSF 24-608](https://www.nsf.gov/funding/opportunities/safe-ose-safety-security-privacy-open-source-ecosystems/nsf24-608/solicitation) for current deadline and FastLane/Research.gov instructions.
- **Full:** Only after invitation following preliminary review. Use this document and the outline above to prepare the full proposal when invited.
- **Resources:** [NSF Safe-OSE FAQ](https://www.nsf.gov/funding/information/faq-nsf-safety-security-privacy-open-source-ecosystems-safe-ose); programme webinars and office hours (see NSF Safe-OSE updates page).
