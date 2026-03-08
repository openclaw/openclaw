## Summary

Add a new `tools.web.fetch.ssrfPolicy` configuration block that lets operators opt-in to allowing the RFC 2544 benchmark IP range (198.18.0.0/15) through the SSRF guard.

## Problem

When OpenClaw runs behind proxy tools that use fake-IP DNS resolution (e.g. **Clash TUN mode** commonly used in China), hostnames resolve to addresses in the 198.18.0.0/15 range. The default SSRF guard correctly identifies these as special-use addresses and **blocks every `web_fetch` request**, making the tool completely unusable.

The `browser` tool already has `ssrfPolicy.dangerouslyAllowPrivateNetwork` for similar scenarios, but `web_fetch` had no equivalent escape hatch.

## Solution

Add a scoped `ssrfPolicy` config to the web fetch tool:

```json
{
  "tools": {
    "web": {
      "fetch": {
        "ssrfPolicy": {
          "allowRfc2544BenchmarkRange": true
        }
      }
    }
  }
}
```

### Changes

| File | Change |
|------|--------|
| `src/config/zod-schema.agent-runtime.ts` | Add `ssrfPolicy` to `ToolsWebFetchSchema` |
| `src/config/types.tools.ts` | Add TypeScript type + JSDoc |
| `src/agents/tools/web-fetch.ts` | Add `resolveSsrfPolicy()`, wire policy through to `fetchWithWebToolsNetworkGuard` |

### Design notes

- **Opt-in only**: The RFC 2544 range remains blocked by default.
- **Minimal surface**: Only `allowRfc2544BenchmarkRange` is exposed; the broader `dangerouslyAllowPrivateNetwork` is intentionally not included to limit security impact.
- **Consistent pattern**: Follows the same `SsrFPolicy` mechanism already used by `withTrustedWebToolsEndpoint` and the browser tool.

Closes #25322
Ref #25258
