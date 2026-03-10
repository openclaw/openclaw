# BMAD PRD Purpose

**The PRD is the top of the required funnel that feeds all subsequent product development work in rhw BMad Method.**

---

## What is a BMAD PRD?

A dual-audience document serving:
1. **Human Product Managers and builders** - Vision, strategy, stakeholder communication
2. **LLM Downstream Consumption** - UX Design → Architecture → Epics → Development AI Agents

Each successive document becomes more AI-tailored and granular.

---

## Core Philosophy: Information Density

**High Signal-to-Noise Ratio**

Every sentence must carry information weight. LLMs consume precise, dense content efficiently.

**Anti-Patterns (Eliminate These):**
- ❌ "The system will allow users to..." → ✅ "Users can..."
- ❌ "It is important to note that..." → ✅ State the fact directly
- ❌ "In order to..." → ✅ "To..."
- ❌ Conversational filler and padding → ✅ Direct, concise statements

**Goal:** Maximum information per word. Zero fluff.

---

## The Traceability Chain

**PRD starts the chain:**
```
Vision → Success Criteria → User Journeys → Functional Requirements → (future: User Stories)
```

**In the PRD, establish:**
- Vision → Success Criteria alignment
- Success Criteria → User Journey coverage
- User Journey → Functional Requirement mapping
- All requirements traceable to user needs

**Why:** Each downstream artifact (UX, Architecture, Epics, Stories) must trace back to documented user needs and business objectives. This chain ensures we build the right thing.

---

## What Makes Great Functional Requirements?

### FRs are Capabilities, Not Implementation

**Good FR:** "Users can reset their password via email link"
**Bad FR:** "System sends JWT via email and validates with database" (implementation leakage)

**Good FR:** "Dashboard loads in under 2 seconds for 95th percentile"
**Bad FR:** "Fast loading time" (subjective, unmeasurable)

### SMART Quality Criteria

**Specific:** Clear, precisely defined capability
**Measurable:** Quantifiable with test criteria
**Attainable:** Realistic within constraints
**Relevant:** Aligns with business objectives
**Traceable:** Links to source (executive summary or user journey)

### FR Anti-Patterns

**Subjective Adjectives:**
- ❌ "easy to use", "intuitive", "user-friendly", "fast", "responsive"
- ✅ Use metrics: "completes task in under 3 clicks", "loads in under 2 seconds"

**Implementation Leakage:**
- ❌ Technology names, specific libraries, implementation details
- ✅ Focus on capability and measurable outcomes

**Vague Quantifiers:**
- ❌ "multiple users", "several options", "various formats"
- ✅ "up to 100 concurrent users", "3-5 options", "PDF, DOCX, TXT formats"

**Missing Test Criteria:**
- ❌ "The system shall provide notifications"
- ✅ "The system shall send email notifications within 30 seconds of trigger event"

---

## What Makes Great Non-Functional Requirements?

### NFRs Must Be Measurable

**Template:**
```
"The system shall [metric] [condition] [measurement method]"
```

**Examples:**
- ✅ "The system shall respond to API requests in under 200ms for 95th percentile as measured by APM monitoring"
- ✅ "The system shall maintain 99.9% uptime during business hours as measured by cloud provider SLA"
- ✅ "The system shall support 10,000 concurrent users as measured by load testing"

### NFR Anti-Patterns

**Unmeasurable Claims:**
- ❌ "The system shall be scalable" → ✅ "The system shall handle 10x load growth through horizontal scaling"
- ❌ "High availability required" → ✅ "99.9% uptime as measured by cloud provider SLA"

**Missing Context:**
- ❌ "Response time under 1 second" → ✅ "API response time under 1 second for 95th percentile under normal load"

---

## Domain-Specific Requirements

**Auto-Detect and Enforce Based on Project Context**

Certain industries have mandatory requirements that must be present:

- **Healthcare:** HIPAA Privacy & Security Rules, PHI encryption, audit logging, MFA
- **Fintech:** PCI-DSS Level 1, AML/KYC compliance, SOX controls, financial audit trails
- **GovTech:** NIST framework, Section 508 accessibility (WCAG 2.1 AA), FedRAMP, data residency
- **E-Commerce:** PCI-DSS for payments, inventory accuracy, tax calculation by jurisdiction

**Why:** Missing these requirements in the PRD means they'll be missed in architecture and implementation, creating expensive rework. During PRD creation there is a step to cover this - during validation we want to make sure it was covered. For this purpose steps will utilize a domain-complexity.csv and project-types.csv.

---

## Document Structure (Markdown, Human-Readable)

### Required Sections
1. **Executive Summary** - Vision, differentiator, target users
2. **Success Criteria** - Measurable outcomes (SMART)
3. **Product Scope** - MVP, Growth, Vision phases
4. **User Journeys** - Comprehensive coverage
5. **Domain Requirements** - Industry-specific compliance (if applicable)
6. **Innovation Analysis** - Competitive differentiation (if applicable)
7. **Project-Type Requirements** - Platform-specific needs
8. **Functional Requirements** - Capability contract (FRs)
9. **Non-Functional Requirements** - Quality attributes (NFRs)

### Formatting for Dual Consumption

**For Humans:**
- Clear, professional language
- Logical flow from vision to requirements
- Easy for stakeholders to review and approve

**For LLMs:**
- ## Level 2 headers for all main sections (enables extraction)
- Consistent structure and patterns
- Precise, testable language
- High information density

---

## Downstream Impact

**How the PRD Feeds Next Artifacts:**

**UX Design:**
- User journeys → interaction flows
- FRs → design requirements
- Success criteria → UX metrics

**Architecture:**
- FRs → system capabilities
- NFRs → architecture decisions
- Domain requirements → compliance architecture
- Project-type requirements → platform choices

**Epics & Stories (created after architecture):**
- FRs → user stories (1 FR could map to 1-3 stories potentially)
- Acceptance criteria → story acceptance tests
- Priority → sprint sequencing
- Traceability → stories map back to vision

**Development AI Agents:**
- Precise requirements → implementation clarity
- Test criteria → automated test generation
- Domain requirements → compliance enforcement
- Measurable NFRs → performance targets

---

## Summary: What Makes a Great BMAD PRD?

✅ **High Information Density** - Every sentence carries weight, zero fluff
✅ **Measurable Requirements** - All FRs and NFRs are testable with specific criteria
✅ **Clear Traceability** - Each requirement links to user need and business objective
✅ **Domain Awareness** - Industry-specific requirements auto-detected and included
✅ **Zero Anti-Patterns** - No subjective adjectives, implementation leakage, or vague quantifiers
✅ **Dual Audience Optimized** - Human-readable AND LLM-consumable
✅ **Markdown Format** - Professional, clean, accessible to all stakeholders

---

**Remember:** The PRD is the foundation. Quality here ripples through every subsequent phase. A dense, precise, well-traced PRD makes UX design, architecture, epic breakdown, and AI development dramatically more effective.
