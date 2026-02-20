# ADR-0001: Governance and Quality Gates

- Status: Accepted
- Date: 2026-02-16
- Deciders: Mission Control engineering maintainers

## Context
Mission Control has grown quickly across API, realtime UI, and orchestration workflows.
Without explicit governance and release gates, regressions (especially scrolling/chat UX and API contract drift) are likely to recur.

## Decision
We enforce the following as non-optional release gates:
1. Keep-a-Changelog style changelog updates for every functional change set.
2. Engineering implementation log updates for each wave or patch group.
3. CI gates for:
   - lint
   - build
   - scroll/chat audit
   - API contract smoke test
   - chat e2e smoke test
   - docs change enforcement
4. Additive-only schema evolution with migration tracking via `schema_migrations`.
5. Standardized API error envelope with request correlation header (`X-Request-Id`).

## Consequences
### Positive
- Faster triage and rollback when incidents happen.
- Better confidence in UI/UX stability across releases.
- Predictable API behavior for internal and external consumers.

### Negative
- Slightly longer CI run time.
- More process overhead on small changes.

## Alternatives considered
1. Lightweight notes only and no docs gate.
   - Rejected due to repeated regressions and unclear operational history.
2. Build/lint only CI.
   - Rejected because it misses UX contract regressions and API drift.
