# Phase 07-02 Role Interaction Map (L044)

Date: 2026-03-08  
Status: completed

## Role Set
1. Executive Operator
2. Memory Steward
3. Systems Engineer
4. Security Agent
5. Research Agent
6. QA Agent

## Interaction Matrix

| From | To | Primary interaction | Trigger | Required artifact |
| --- | --- | --- | --- | --- |
| Executive Operator | Memory Steward | memory policy direction | policy ambiguity, correction disputes | policy decision note |
| Executive Operator | Systems Engineer | rollout/change authorization | runtime/config changes | change approval log |
| Executive Operator | Security Agent | risk acceptance/escalation | high-risk tool paths, security incidents | security escalation record |
| Executive Operator | Research Agent | requirement framing | unknown design space, external options | research brief |
| Executive Operator | QA Agent | release readiness decision | gate review before promotion | verification sign-off |
| Memory Steward | Executive Operator | policy escalation | contradiction/provenance conflict | memory governance incident note |
| Memory Steward | QA Agent | memory test expectations | suite updates, false positives | test expectation update |
| Systems Engineer | Security Agent | control hardening review | infra/tooling modifications | hardening checklist |
| Systems Engineer | QA Agent | implementation verification | runtime change completed | test run evidence |
| Security Agent | Systems Engineer | mitigation requirements | threat/vulnerability detected | mitigation plan |
| Research Agent | Executive Operator | recommendation submission | policy/tooling alternatives found | recommendation memo |
| Research Agent | Systems Engineer | feasibility input | proposed architecture changes | feasibility note |
| QA Agent | Executive Operator | gate outcome report | acceptance suite completion | gate package |
| QA Agent | Memory Steward | contradiction findings | memory anomalies in tests | contradiction report |
| QA Agent | Systems Engineer | defect handoff | regressions found | defect ticket/evidence |

## Escalation Paths
1. Security risk override path: Security Agent -> Executive Operator (blocking).
2. Memory contradiction path: Memory Steward -> Executive Operator (blocking for unresolved truth conflicts).
3. Release gate path: QA Agent -> Executive Operator (blocking when acceptance criteria fail).

## Decision Rights
1. Executive Operator: final approve/reject on rollout and constitutional interpretation.
2. Memory Steward: authoritative recommendation on memory truth/provenance controls.
3. Systems Engineer: implementation owner for approved runtime/infrastructure changes.
4. Security Agent: veto/restriction authority for unresolved critical security risk.
5. Research Agent: advisory authority; no direct production-change authority.
6. QA Agent: release gate authority on test evidence quality/completeness.

## Handoff Rules
1. Every blocking escalation must include a concrete artifact reference.
2. Role-to-role handoffs must include action owner and due checkpoint.
3. Any contradiction between role recommendations defaults to Executive Operator adjudication.
