# Security Advisory: OC-201

## Hook Transform Dynamic Module Import RCE

**Severity**: HIGH (CVSS 8.1)
**CVE**: Pending
**CWE**: CWE-94 (Code Injection)
**Affected**: OpenClaw Gateway <= v2026.2.9
**Fixed In**: v2026.2.10+

### Description

The hook transform module loader in `src/gateway/hooks-mapping.ts` performed dynamic `import()` on attacker-controlled module paths without symlink-safe path containment. An authenticated attacker could override `hooks.transformsDir` to an arbitrary filesystem location via `config.patch`, then trigger hook execution to achieve Remote Code Execution (RCE).

### Attack Vector

1. Attacker authenticates to gateway and obtains valid session
2. Attacker calls `config.patch()` API to override `hooks.transformsDir` to arbitrary path (e.g., `/tmp`, `/var/www`)
3. Attacker places malicious JavaScript file at target location
4. Attacker triggers a hook that attempts to load transform modules
5. `resolveContainedPath()` fails to properly validate symlink-based path escapes
6. Dynamic `import()` loads and executes attacker's arbitrary code with full Node.js runtime privileges

### Impact

An authenticated attacker with a valid gateway session could:
- Execute arbitrary code on the host as the gateway process user
- Read private keys and sensitive files
- Exfiltrate data from the system
- Establish persistent backdoors
- Pivot to other services on the network

### Root Cause

The original `resolveContainedPath()` function in `hooks-mapping.ts` used only lexical path validation (string manipulation) without canonical filesystem path resolution. This allowed attackers to bypass containment via:
- Symlinks pointing outside the base directory
- Absolute path override via config (no validation at schema level)
- Nested path traversal sequences

### Fix

The fix implements three layers of defense:

1. **Zod Schema Validation** (`src/config/zod-schema.ts`):
   - Reject absolute paths in `hooks.transformsDir`
   - Reject path traversal sequences (`..`, `./`, `/`)
   - Validate at configuration load time

2. **Canonical Path Resolution** (`src/gateway/hooks-mapping.ts`):
   - Added `fs.realpathSync()` to resolve all symlinks to canonical paths
   - Compare canonical paths to ensure containment
   - Reject any paths that try to reference absolute paths

3. **Security Tests** (`src/gateway/hooks-mapping.test.ts`):
   - Test symlink module bypass prevention
   - Test symlink transformsDir bypass prevention
   - Test nested path traversal blocking
   - Test absolute path override prevention
   - Test config validation with invalid paths
   - Test ENOENT graceful fallback

### Verification

To verify the fix is in place:

```bash
# Check that fs.realpathSync is used in resolveContainedPath
grep -A 20 "function resolveContainedPath" src/gateway/hooks-mapping.ts | grep realpathSync

# Check that Zod validation includes transformsDir constraints
grep -A 5 "transformsDir" src/config/zod-schema.ts | grep -E "(refine|startsWith|includes)"

# Run security tests
npm test -- --grep "OC-201|symlink|traversal"
```

### Mitigation

Until upgraded, operators should:
1. Restrict API access to `config.patch` endpoints
2. Use network segmentation to limit gateway access
3. Monitor for unusual hook transform behavior
4. Rotate secrets/keys potentially exposed via RCE

### Credits

Discovered and reported by Aether AI Agent security research team.

### References

- CWE-94: Improper Control of Generation of Code ('Code Injection')
  https://cwe.mitre.org/data/definitions/94.html
- OWASP Path Traversal: https://owasp.org/www-community/attacks/Path_Traversal
- Symlink Attack: https://owasp.org/www-community/attacks/Symlink_Attack
