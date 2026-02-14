# Dispatch E2E Scaffold

Implemented canonical harness:

- `dispatch/tests/story_08_e2e_canonical.node.test.mjs`

Scenario chain covered by current harness:

1. intake creates ticket
2. triage marks emergency type/priority
3. emergency dispatch assignment (`EMERGENCY_BYPASS`)
4. technician checks in via `tech.check_in` (`DISPATCHED -> ON_SITE -> IN_PROGRESS`)
5. fail-closed `tech.complete` rejection with missing evidence
6. evidence upload + idempotent replay check
7. successful `tech.complete` to `COMPLETED_PENDING_VERIFICATION`
8. QA verification via `qa.verify` (`-> VERIFIED`)
9. invoice generation via `billing.generate_invoice` (`-> INVOICED`)
10. timeline/audit/transition integrity assertions
