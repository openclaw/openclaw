---
title: "Node Identity Refactor"
summary: "Refactor: derive node eligibility from active device tokens, centralize node view assembly, and score node resolution ties explicitly"
author: "Peter Steinberger <steipete@gmail.com>"
github_username: "steipete"
created: "2026-03-29"
status: "implemented"
read_when:
  - "Tracing why node.list or node.describe shows stale paired devices as nodes"
  - "Changing node name/id/IP resolution or legacy clawdbot migration heuristics"
---

Problem:

- device pairing stored historical `roles`
- `node.list` treated that sticky field as current node eligibility
- handshake upgrade checks also read sticky roles
- result: revoked/stale legacy node identities still looked like real nodes

Refactor:

- `src/infra/device-pairing.ts`
  - added effective-role helpers
  - active non-revoked tokens are source of truth when tokens exist
  - legacy `role` / `roles` only used as fallback for token-less records
- `src/gateway/node-catalog.ts`
  - shared node view builder for `node.list` / `node.describe`
- `src/shared/node-match.ts`
  - explicit match scoring: exact id > IP > normalized name > long prefix
  - then connected/current-client tie-breaks

Expected outcome:

- stale revoked node tokens stop surfacing as nodes
- `node.list` / `node.describe` stay in sync
- future matcher tweaks happen in one place instead of ad hoc branches
