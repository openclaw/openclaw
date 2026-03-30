---
title: "PR 57340 telegram plugin approval follow-up"
summary: "Maintainer follow-up for the Telegram plugin approval PR to add regression coverage and remove the request cast."
author: "Vincent Koc"
github_username: "vincentkoc"
created: "2026-03-30T00:37:48Z"
---

PR `#57340` was close, but it needed merge-grade tests.

Maintainer follow-up:

- add Telegram approval-handler tests for `plugin.approval.requested` and `plugin.approval.resolved`
- keep the existing exec approval coverage in place
- widen the shared session-target helper to the minimal request shape so the Telegram handler no longer needs a cast for plugin approvals
- preserve explicit `resolvedBy` identities through the direct gateway approval resolve path so Telegram callback approvals keep the real approver in audit/result flows
