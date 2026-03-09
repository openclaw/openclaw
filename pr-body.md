## Summary

Add a new `ssrfPolicy.allowRfc2544BenchmarkRange` configuration option for both the `web_fetch` tool and the `browser` tool, letting operators opt-in to allowing the RFC 2544 benchmark IP range (198.18.0.0/15) through the SSRF guard.

## Problem

When OpenClaw runs behind proxy tools that use fake-IP DNS resolution (e.g. **Clash TUN mode** commonly used in China), hostnames resolve to addresses in the 198.18.0.0/15 range. The default SSRF guard correctly identifies these as special-use addresses and **blocks every `web_fetch` and `browser` request**, making both tools completely unusable.

## Solution

Add a scoped `ssrfPolicy` config to both the web fetch tool and the browser tool:

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
  },
  "browser": {
    "ssrfPolicy": {
      "allowRfc2544BenchmarkRange": true
    }
  }
}
```

### Changes

| File | Change |
|------|--------|
| `src/config/zod-schema.agent-runtime.ts` | Add `ssrfPolicy` to `ToolsWebFetchSchema` |
| `src/config/zod-schema.ts` | Add `allowRfc2544BenchmarkRange` to browser `ssrfPolicy` schema |
| `src/config/types.tools.ts` | Add TypeScript type + JSDoc for web fetch |
| `src/config/types.browser.ts` | Add `allowRfc2544BenchmarkRange` to `BrowserSsrFPolicyConfig` |
| `src/config/schema.help.ts` | Add help text for browser config field |
| `src/config/schema.labels.ts` | Add label for browser config field |
| `src/agents/tools/web-fetch.ts` | Add `resolveSsrfPolicy()`, wire policy through to `fetchWithWebToolsNetworkGuard` |
| `src/browser/config.ts` | Pass through `allowRfc2544BenchmarkRange` in `resolveBrowserSsrFPolicy` |
| `src/browser/config.test.ts` | Add tests for browser config resolution with `allowRfc2544BenchmarkRange` |
| `src/browser/navigation-guard.test.ts` | Add tests for RFC 2544 range blocking/allowing |

### Design notes

- **Opt-in only**: The RFC 2544 range remains blocked by default.
- **Minimal surface**: Only `allowRfc2544BenchmarkRange` is exposed; the broader `dangerouslyAllowPrivateNetwork` is intentionally not included for web fetch to limit security impact.
- **Consistent pattern**: Follows the same `SsrFPolicy` mechanism already used by `withTrustedWebToolsEndpoint` and the browser tool.
- **Both tools covered**: Browser tool now supports the same `allowRfc2544BenchmarkRange` option alongside its existing `dangerouslyAllowPrivateNetwork`.

Closes #25322
Ref #25258
