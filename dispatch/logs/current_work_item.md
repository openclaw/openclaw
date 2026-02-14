# Current Work Item

## Story ID
`MVP-03`

## Epic
`EPIC-MVP-02: Security Hardening`

## Priority
`P0`

## Completion Status
`MVP-01` and `MVP-02` are complete and validated. `MVP-03` is now the next critical path item.

## Suggested Focus Area
Implement production-grade authentication and claim-bound authorization:
- replace trust-on-header actor context with signed claims validation
- bind actor identity/role to server-side authorization checks
- enforce scope boundaries (account/site) from claims across ticket operations
- add negative tests for forged/invalid claims and role mismatch
