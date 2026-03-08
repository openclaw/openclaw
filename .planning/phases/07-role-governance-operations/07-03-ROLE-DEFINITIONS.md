# Phase 07-03 Formalized Role Definitions (L038-L043)

Date: 2026-03-08
Status: completed

## Executive Summary

Formal definitions of six roles operating within FrankOS governance system, each with explicit authority boundaries, responsibility scope, and escalation rights.

---

## L038: Executive Operator

**Authority Level**: Final decision authority

**Primary Responsibilities**:
1. Governance policy promotion and rollback decisions
2. Constitutional interpretation and disputes
3. Escalation adjudication (final arbiter on contradictions)
4. Risk acceptance and security override decisions
5. Rollout phase advancement (dev-shadow → canary-enforce → prod-enforce)

**Decision Rights**:
- Approve/reject rollout stage transitions
- Interpret constitutional constraints for novel situations
- Adjudicate Memory Steward vs. Systems Engineer disputes
- Accept documented security risks
- Authorize experimental governance configurations

**Cannot Override**:
- Fail-closed enforcement behavior (fail-closed is immutable)
- Memory provenance validation requirements
- Security Agent veto on unresolved critical risks
- Audit trail and telemetry requirements

**Escalation Triggers**:
- Memory Steward escalates unresolved truth conflicts
- Security Agent escalates unresolved critical risks
- QA Agent blocks release gate on failed acceptance criteria
- Systems Engineer requests authorization for infrastructure change

**Interaction Artifacts**:
- Change approval log (rollout/infrastructure changes)
- Security escalation record (risk acceptance)
- Research brief (policy/tooling alternatives)
- Memory policy decision note (memory governance disputes)
- Gate package (release readiness sign-off)

---

## L039: Memory Steward

**Authority Level**: Authoritative recommendation on memory truth and provenance

**Primary Responsibilities**:
1. Memory governance policy interpretation
2. Provenance validation and truth conflict arbitration
3. Correction and supersession workflow approval
4. Memory governance telemetry quality assurance
5. Contradiction analysis and root cause investigation

**Decision Rights**:
- Recommend memory policy changes
- Approve/reject memory corrections and supersessions
- Set confidence thresholds for provenance validation
- Define uncertainty tagging standards
- Authorize memory policy variance in specific contexts

**Cannot Override**:
- Executive Operator decision authority
- Constitutional memory integrity requirements
- QA test expectations for memory governance

**Escalation Triggers**:
- Unresolved truth conflicts (escalate to Executive Operator)
- Correction disputes affecting multiple agents (escalate to Executive Operator)
- Memory anomalies found in QA testing (coordinate with QA Agent)
- Policy drift or validation failures (escalate to Executive Operator)

**Interaction Artifacts**:
- Memory policy decision note (disputes and policy changes)
- Contradiction report (from QA, triggers analysis)
- Test expectation update (response to QA findings)
- Memory governance incident note (escalations)

---

## L040: Systems Engineer

**Authority Level**: Implementation owner for approved runtime/infrastructure changes

**Primary Responsibilities**:
1. Governance runtime deployment and configuration
2. Infrastructure hardening and security control implementation
3. Diagnostics and telemetry pipeline integration
4. Rollback readiness and incident response procedures
5. Test harness maintenance and environment setup

**Decision Rights**:
- Determine technical approach for approved policy implementations
- Set operational thresholds (telemetry sampling, block rates, etc.)
- Optimize runtime performance within policy constraints
- Design rollback procedures and automation
- Implement security hardening recommendations

**Cannot Override**:
- Executive Operator change authorization
- Security Agent mitigation requirements
- Constitutional enforcement boundaries
- Audit trail requirements (no silent failures allowed)

**Escalation Triggers**:
- Security Agent identifies control hardening needs
- QA Agent discovers implementation defects
- Rollout encounter unexpected block rates
- Infrastructure change request from Executive Operator
- Diagnostic pipeline failure during enforce mode

**Interaction Artifacts**:
- Change approval log (implementation owner assignment)
- Hardening checklist (security control implementation)
- Mitigation plan (security agent requirements)
- Test run evidence (implementation verification)
- Defect ticket/evidence (QA findings)

---

## L041: Security Agent

**Authority Level**: Veto/restriction authority for unresolved critical security risk

**Primary Responsibilities**:
1. Security threat and vulnerability assessment
2. Control hardening requirement definition
3. Risk classification and escalation
4. Incident response and mitigation tracking
5. Defensive posture maintenance

**Decision Rights**:
- Block promotions or runtime changes due to unresolved critical risk
- Require security control hardening before implementation
- Define risk mitigation procedures
- Recommend security-specific telemetry or audit requirements
- Restrict tool access or action scopes based on security analysis

**Cannot Override**:
- Executive Operator risk acceptance decision
- Approved constitutional enforcement (cannot weaken it)
- Auditing and logging requirements

**Escalation Triggers**:
- Critical security risk encountered (escalate to Executive Operator)
- Mitigation implementation disagreement (escalate to Systems Engineer)
- Post-incident analysis recommendations (coordinate with Systems Engineer)

**Interaction Artifacts**:
- Security escalation record (to Executive Operator)
- Hardening checklist (to Systems Engineer)
- Mitigation plan (with completion tracking)
- Incident analysis (post-event review)

---

## L042: Research Agent

**Authority Level**: Advisory authority; no direct production-change authority

**Primary Responsibilities**:
1. Exploration of alternative policy/tooling approaches
2. External best-practice research
3. Feasibility analysis for proposed changes
4. Technology landscape assessment
5. Design option evaluation and recommendation

**Decision Rights**:
- Conduct independent research on governance topics
- Evaluate design alternatives
- Submit feasibility notes on proposed changes
- Recommend architectural directions

**Cannot Override**:
- Any production decision (no direct authority)
- Constitutional constraints
- Executive Operator priority decisions
- Approved implementation approaches (research is advisory only)

**Escalation Triggers**:
- Novel governance question arises (proactively research)
- Architecture alternative proposed by stakeholder (evaluate feasibility)
- Policy change request from Executive Operator (research options)

**Interaction Artifacts**:
- Research brief (to Executive Operator)
- Feasibility note (to Systems Engineer)
- Recommendation memo (advisory submission)

---

## L043: QA Agent

**Authority Level**: Release gate authority on test evidence quality/completeness

**Primary Responsibilities**:
1. Governance acceptance criteria definition and evolution
2. Test suite design and maintenance
3. Evidence collection and result validation
4. Contradictions and anomalies detection
5. Gate decision and sign-off authority

**Decision Rights**:
- Block releases when acceptance criteria fail
- Redefine test expectations based on validated findings
- Reject evidence lacking required fields or precision
- Require additional test scenarios before gate sign-off
- Recommend acceptance criteria changes to Memory Steward

**Cannot Override**:
- Executive Operator rollout stage decision (after gate passes)
- Constitutional enforcement requirements (gates assume these are fixed)
- Security or Memory escalations

**Escalation Triggers**:
- Failed acceptance scenario (gate blocks until resolved)
- Contradictions detected in memory tests (escalate to Memory Steward)
- Defects found during testing (escalate to Systems Engineer)
- Missing required telemetry (escalate to Systems Engineer)
- Gate threshold disagreement (escalate to Executive Operator)

**Interaction Artifacts**:
- Gate package (with scenario results and sign-off)
- Test expectation update (response to Memory Steward)
- Defect ticket/evidence (to Systems Engineer)
- Contradiction report (to Memory Steward)

---

## Role Interaction Summary

**Blocking Escalation Paths**:
1. **Security Risk Override**: Security Agent → Executive Operator (blocks rollout/change)
2. **Memory Truth Conflict**: Memory Steward → Executive Operator (blocks correction/policy change)
3. **Release Gate Failure**: QA Agent → Executive Operator (blocks promotion)

**Advisory Paths** (no blocking authority):
- Research Agent → Executive Operator (recommendations only)
- Research Agent → Systems Engineer (feasibility input only)

**Coordination Paths** (non-blocking):
- Systems Engineer ↔ Security Agent (hardening review)
- Systems Engineer ↔ QA Agent (implementation verification)
- Memory Steward ↔ QA Agent (memory test expectations)

---

## Authority Boundaries - Key Constraints

1. **Executive Operator Final Authority**: All disputes default to Executive Operator adjudication.
2. **Fail-Closed Is Immutable**: No role can relax fail-closed enforcement behavior.
3. **Audit Trail Non-Negotiable**: All roles must preserve complete audit trails for their decisions.
4. **Constitutional Constraints Binding**: No role can override constitutional memory or enforcement requirements.
5. **Role Independence**: Roles maintain independent analysis; no role silently defers to another's judgment without rationale.

---

## Exit Criteria Status

- [x] L038: Executive Operator defined with decision authority boundaries
- [x] L039: Memory Steward defined with truth/provenance authority
- [x] L040: Systems Engineer defined with implementation ownership
- [x] L041: Security Agent defined with veto/restriction authority
- [x] L042: Research Agent defined with advisory scope
- [x] L043: QA Agent defined with gate authority

**Phase 07-03 Complete**: All role definitions formalized and authority boundaries established.
