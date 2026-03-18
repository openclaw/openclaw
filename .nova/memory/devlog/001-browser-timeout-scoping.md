---
tags: [browser, existing-session, chrome-mcp, timeout, sandbox, proxy]
modules: [agents/tools/browser-tool, browser/client, browser/routes/tabs]
summary: "Scope browser manage 45s timeouts to host existing-session paths"
tag: mem/001
---

# DevLog 001: Scope Browser Manage Timeouts to Host Existing-Session Paths

## Date

2026-03-18 21:25

## Context

A browser-tool timeout patch started by raising the shared browser client
fallbacks for `status`, `profiles`, and `tabs` to 45 seconds so
`profile=user` / existing-session calls would stop timing out.

Review surfaced that the same client helpers also drive sandbox and
remote bridge calls, so the broader default would turn dead remote
sessions into long 45-second stalls. The close action also had a split
implementation where the proxy fallback and the host `/act` fallback did
not both honor the caller's timeout.

## Insight

The 45-second manage window is appropriate for local host
existing-session / Chrome MCP paths, not for the shared browser client
layer.

The safer pattern is:

- keep the browser client fast-fail defaults (`status` 1500ms,
  `profiles`/`tabs` 3000ms)
- inject the longer timeout from `agents/tools/browser-tool.ts` only when
  the tool is talking directly to a host-only existing-session profile
- preserve shorter behavior for sandbox and node/remote paths unless the
  caller explicitly supplies `timeoutMs`
- test both close fallbacks, because `close` can route through
  `/tabs/:targetId` or `/act`

For targetless host close, the tool also needs the `browserAct()` fetch
wrapper to accept an outer `timeoutMs`; otherwise the browser-tool layer
can "pass" a timeout that still gets capped at the old 20-second fetch
limit.

## Implications

- When fixing slow browser manage calls, first identify whether the delay
  is local existing-session specific or shared across all transports.
- Avoid widening `browser/client.ts` defaults unless every consumer
  should inherit the slower failure mode.
- For browser-tool timeout work, cover direct host calls and proxy calls
  separately, especially `close` without `targetId`.
- If an existing-session tab-list fast path skips a reachability probe,
  map `listTabs()` failures back through the tab error mapper so the UX
  stays human-readable.
