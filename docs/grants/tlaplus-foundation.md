# TLA+ Foundation — Grant Application

- **Funder:** [TLA+ Foundation](https://foundation.tlapl.us/grants/2024-grant-program/index.html)
- **Award range:** $1,000–$100,000; completion within one year (exceptions possible)
- **Apply:** [Application template (Google Doc)](https://docs.google.com/document/d/17OF2InWnwELb1NzwamyXsfglu1F57JGfYra1lsodmF0/edit) and submit via form on foundation site. Contact: <grants@tlapl.us>

- **Eligibility:** Researchers and practitioners (industry and academia); must accept unrestricted grant, no conflicting obligations, in a location where U.S. participation is permitted. New software: Apache 2.0, 2-Clause BSD, or MIT preferred.
- **ConsentGate implementation status:** Mode A in production; durable store, live Control UI, observability, tier/rate-limit policy, and quarantine lift API implemented. TLA+ spec and conformance work proposed in this application.

---

## Placeholders (fill or mark TBD before submission)

- **[Host organization]:** TBD (if required)
- **[PI and contributors]:** David Weatherspoon (lead); TBD others
- **[Budget]:** TBD (e.g. within $1K–$100K range)
- **[Timeline]:** Example 4 months in draft; adjust per application

---

## Project title

TLA+ Specification and Conformance for ConsentGuard: Consent-Gated Tool Authorization and Containment

---

## Proposed work (max 2 pages — use this as draft)

**Background:** ConsentGuard is a security layer for the OpenClaw AI agent platform (project lead: **David Weatherspoon** — [Medium](https://medium.com/@reconsumeralization), [GitHub](https://github.com/reconsumeralization)). It enforces consent-gated tool execution informed by **reconsumeralization**—re-establishing explicit, auditable consent per action rather than assumed or one-time authorization: no high-risk tool runs without a valid token; tokens are single-use (P2) and context-bound (P3); revocation is immediate (P5); containment caps autonomous ops and triggers quarantine and cascade revoke (C3–C5). The design is described with informal properties (P1–P5, C3–C5) and is intended to be specified formally for verification and conformance testing.

**Goals:**

1. Write a **TLA+ specification** of the ConsentGuard core: token state (issued/consumed/revoked/expired), issue/consume/revoke operations, context hash and binding, containment state (score, quarantine, ops count, window).
2. **Model-check** key invariants (e.g. no double consume, no execution without consent, revocation invalidates token, containment triggers at threshold).
3. **Document conformance:** relate the implementation (or a reference implementation) to the spec — which behaviours are specified, and how tests or traces align with the spec (e.g. test suite that can be viewed as conformance checks).
4. **Publish** the TLA+ spec, model-checking results, and a short conformance note under an open license (MIT/BSD/Apache 2.0).

**Relevance to TLA+:** The project uses TLA+ to specify and verify a security-critical authorization and containment system. It fits the Foundation’s goals of “TLA+ specifications for distributed/concurrent systems” and “conformance of implementations to specifications.” Outcomes benefit the TLA+ community by providing a real-world, security-oriented spec and a pattern for consent/authorization systems.

**Timeline (example):**

- Months 1–2: Draft TLA+ spec (state, actions, invariants).
- Month 3: Model-check and fix spec; document results.
- Month 4: Conformance note and test mapping; polish and release.

**Expected outcomes and benefits to TLA+:**

- A public TLA+ specification for a consent-gated authorization engine, reusable as a template.
- Demonstrated use of TLA+ for security properties (single-use, context binding, containment).
- Material (spec + conformance note) that can be cited in tutorials and case studies.

---

## Award amount and justification

- **Requested:** [e.g. $15,000–$50,000] for PI/contributor time to write the spec, run model-checking, and document conformance.
- **Justification:** Enables dedicated focus on the TLA+ spec and conformance without requiring a full-time team; deliverables are spec, model-check results, and conformance documentation. For requests ≥$50,000, provide detailed budget, timeline, and success metrics in the application template.

---

## Team

- **List team members** and roles: **David Weatherspoon** (reconsumeralization on [Medium](https://medium.com/@reconsumeralization), [GitHub](https://github.com/reconsumeralization)) — PI / spec and conformance lead; [spec author, model-checking, implementation/conformance as needed]. Solo applications are accepted.
- **CV/résumé:** Attach max 3 pages per person (include PI’s work on reconsumeralization and ConsentGuard where relevant).
- **Prior work:** Describe any prior TLA+ or formal-methods experience; existing ConsentGuard/OpenClaw design docs or demos; and the PI’s reconsumeralization framework (re-consent, audit, revocation as first-class design goals) that the spec will formalise.

---

## Where to submit

1. Fill out the [TLA+ Foundation application template](https://docs.google.com/document/d/17OF2InWnwELb1NzwamyXsfglu1F57JGfYra1lsodmF0/edit).
2. Submit via the form on [foundation.tlapl.us/grants](https://foundation.tlapl.us/grants/2024-grant-program/index.html).
3. Contact <grants@tlapl.us> for questions. The programme is rolling; no fixed deadline.
