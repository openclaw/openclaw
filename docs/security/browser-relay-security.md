# Browser Relay Server Security Configuration Guide

## Background
A high-severity vulnerability (CVE-2026-25253) was fixed in the January 29, 2026 release. This vulnerability allowed attackers to execute arbitrary code on the browser relay server via malicious webpages, potentially stealing locally stored API keys and credentials. This document helps users verify the fix and securely configure the relay server.

## Verify the Fix
1. **Check Version**: Ensure you are running version ≥ 2026.1.29. Run `openclaw version` to check.
2. **Check Origin Header Validation**: By default, the relay server only accepts WebSocket connections from `http://localhost:18789`. If you have customized `allowedOrigins`, ensure it does not include untrusted origins.
3. **Test Authentication**: Accessing the `/cdp` endpoint should return a 401 Unauthorized response, rather than directly establishing a WebSocket connection.

## Security Best Practices
- **API Key Management**: Avoid hardcoding keys in configuration files. Prefer environment variables (e.g., `OPENCLAW_API_KEY`).
- **Network Isolation**: In production, deploy the relay server on an internal network and avoid direct public exposure. If public access is required, enable strong authentication and HTTPS.
- **Log Auditing**: Regularly review logs for unusual WebSocket connection attempts.
- **Update Strategy**: Subscribe to GitHub security advisories and upgrade promptly.

## FAQ
**Q: The relay server cannot connect after upgrading?**  
A: Check if your `allowedOrigins` configuration includes your frontend domain. For example, if the frontend runs on `http://localhost:3000`, add `"http://localhost:3000"` to the list.

**Q: How to verify Origin header validation is working?**  
A: Use curl to simulate an illegal Origin: `curl -H "Origin: http://evil.com" -H "Host: localhost:18789" http://localhost:18789/cdp`. It should return 403.

## References
- [CVE-2026-25253 Details](https://nvd.nist.gov/vuln/detail/CVE-2026-25253)
- [Original fix commit a1e89af](https://github.com/openclaw/openclaw/commit/a1e89afcc19efd641c02b24d66d689f181ae2b5c)
