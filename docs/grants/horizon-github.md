# Horizon Europe & GitHub Secure Open Source Fund — Application Notes

Enhanced notes for two additional streams; full applications depend on specific calls and programme rules.

- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented.

---

## Horizon Europe (EU)

### Relevant calls and angles

| Call / programme                                                  | Focus                                                 | ConsentGuard angle                                                                                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Explainable and robust AI** (e.g. HORIZON-CL4-2024-HUMAN-03-02) | Trustworthy, robust, safe AI in real-world conditions | ConsentGuard provides **auditable** and **explainable** decisions: every allow/deny is logged with reason (consent, tier, containment). Robustness: containment limits impact of abuse. |
| **European Lighthouse on Secure and Safe AI**                     | Robustness, safety, privacy, **human oversight**      | **Human oversight**: explicit consent before high-risk tool execution; **audit trail** (WAL) for transparency and accountability.                                                       |
| **AI transparency and robustness** (~€15M)                        | Human-centric AI, transparency                        | **Transparent decisions**: WAL records why each tool call was allowed or denied (token, tier, anomaly).                                                                                 |

### Positioning statement (for Part B / impact)

“We will implement and evaluate a **consent and audit layer (ConsentGuard)** for an open-source AI agent platform (OpenClaw), led by **David Weatherspoon** ([reconsumeralization](https://medium.com/@reconsumeralization) on Medium, [reconsumeralization](https://github.com/reconsumeralization) on GitHub). ConsentGuard embodies **reconsumeralization**—re-centering explicit, revocable consent in agent tool execution so authorization is re-established per action and fully logged. It ensures no high-risk action runs without explicit consent (token), tags input by trust source (owner, peer, email, feed), and writes every decision to a write-ahead log. This supports **human oversight**, **robust** and **transparent** AI deployment, and a reusable design for human-in-the-loop agent systems.”

### Work package sketch (if ConsentGuard is a WP)

- **WP1 — Specification and design:** Properties (P1–P5, C3–C5), WAL schema, trust-tier model; threat model and attack scenarios.
- **WP2 — Implementation:** Core ConsentGuard library; integration with gateway invoke path; config and containment.
- **WP3 — Evaluation and audit:** Attack-scenario suite (eight scenarios), regression tests, evaluation report; WAL tooling for audit.
- **WP4 — Dissemination and reuse:** Operator guide, integration guide, adoption guide for other agent platforms; open-source release; engagement with EU and international safety/standardisation bodies.

### Eligibility and next steps

- **Eligibility:** Most Horizon calls require **EU-based partners** and **consortium** structure. Check [EU Funding Portal](https://eufundingportal.eu/) and [CORDIS](https://cordis.europa.eu/) for open calls; match keywords: **human oversight**, **robust AI**, **safe AI**, **audit**, **transparency**, **explainability**.
- **Next step:** Identify an open call; form or join a consortium with an EU university or RTO; use the positioning statement and WP sketch in Part B; add ConsentGuard as a use case or dedicated work package depending on call scope.

---

## GitHub Secure Open Source Fund (SOSF)

### Programme focus

- **Maintainers** and **security outcomes** in open source.
- **Fast-growing dependencies** and security improvements.
- Partners include Alfred P. Sloan Foundation, Microsoft, Stripe.

### Project description (ready to paste or adapt)

**Title:** ConsentGuard — Consent and Audit Layer for OpenClaw

**Summary:** OpenClaw is an open-source, multi-channel AI agent platform with broad adoption. High-risk tools (shell, filesystem, skill install, cron) are executable by the agent; prompt injection, supply-chain compromise via skills, and session bleed pose real security risks. Led by **David Weatherspoon** ([reconsumeralization](https://github.com/reconsumeralization)), we propose implementing **ConsentGuard**, grounded in **reconsumeralization**—re-establishing explicit, auditable consent per action: a security layer that gates every high-risk tool call on a **consent token** (single-use, context-bound), enforces **trust tiers** by channel/source (so email or social-feed content cannot authorize shell or credential access), and writes **every decision** to a **write-ahead log (WAL)** for audit. Containment logic (anomaly scoring, quarantine, cascade revoke) limits blast radius. **Deliverables:** (1) ConsentGuard integrated into the OpenClaw gateway invoke path; (2) public **WAL format** and optional tooling; (3) **attack-scenario suite** (eight scenarios) with expected blocks and regression tests; (4) **operator and integration docs** so deployers and other projects can adopt the pattern. All code and docs will be open source (MIT). This directly improves **security outcomes** for OpenClaw and for any ecosystem that reuses the design.

**Impact:** Deployers get a clear consent and audit story; incident response can use the WAL; other agent projects can adopt the consent-gate pattern and WAL format. The work is maintainer-driven and focused on concrete security deliverables (no high-risk tool without consent, full audit trail, containment).

### Application

- Apply via the programme’s official channel (check [GitHub Secure Open Source Fund](https://resources.github.com/github-secure-open-source-fund) for current application link).
- Emphasise: (1) **OpenClaw’s adoption and criticality**; (2) **concrete security deliverables** (consent gate, WAL, containment, attack-scenario suite); (3) **public documentation and scenarios** for the community; (4) **maintainer ownership** and sustainability.

---

## Summary table

| Funder             | Use this doc as                           | Next step                                                                                                                                |
| ------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Horizon Europe** | Narrative and work-package building block | Find open call; form consortium with EU partner; fill Part B with ConsentGuard as WP or case study; use positioning statement in impact. |
| **GitHub SOSF**    | Project description and impact text       | Apply via SOSF application when open; paste or adapt the **Project description** above; stress security outcomes and maintainer focus.   |
