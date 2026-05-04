Title: Scoped media tickets for Control UI assistant-media

Related issue: https://github.com/openclaw/openclaw/issues/70830
References:

- https://github.com/openclaw/openclaw/pull/75094
- https://github.com/openclaw/openclaw/pull/77111

## Summary

This branch starts a focused PR to implement scoped, short-lived media tickets
for the Control UI `assistant-media` route to avoid placing long-lived
credentials in browser-visible `?token=` query parameters.

Planned work (focused / minimal):

- Add gateway-signed short-lived media ticket generation for `assistant-media`.
- Accept `?mediaTicket=...` (or `Authorization: Bearer ...`) for browser media
  requests; keep `?token=` only as a legacy import/fallback where necessary.
- Add tests mirroring current `?token=` flows and validating media ticket TTL
  and scope enforcement.
- Reference and reuse prior work in PRs #75094 and #77111 where applicable.

## Notes

- This PR is intentionally narrow: it implements scoped media tickets and the
  minimal plumbing required for Control UI native rendering while avoiding
  larger auth-model refactors (cookies/session or header-fetch+blob approaches).

## Next steps

1. Implement code changes in `src/gateway/*` to generate and validate media
   tickets.
2. Add tests under `src/gateway/*` and `ui/*` to exercise native media URL
   rendering with media tickets.
3. Open draft PR and link to the issue & referenced PRs.
