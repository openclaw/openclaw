# Skill Auditor Documentation

## Overview

The **Skill Auditor** is a mandatory security component that scans all skills before installation to prevent malicious code injection. It performs deep static analysis including AST dataflow analysis to identify security vulnerabilities, unsafe commands, and malicious patterns.

## Security Context

The Skill Auditor is part of a comprehensive security audit suite:

- **skill-auditor** (this): Scans skills for malicious code and unsafe patterns
- **auth-auditor**: Validates authentication and authorization code
- **audit-code**: Detects secrets, SQL injection, and other code vulnerabilities  
- **permission-auditor**: Checks environment and configuration permissions

## Threat Statistics

Based on industry analysis, approximately **7.1% of online skills** may contain malicious software. The Skill Auditor prevents these threats from entering your system.

## Detection Categories

### 🔴 Critical Severity (Blocks Installation)

1. **Malicious Code (MAL-001)**
   - Known malware signatures
   - Base64 decode + eval patterns
   - Hidden child_process imports
   - Native binding access attempts
   - Remote code execution patterns

2. **Data Exfiltration (EXF-001)**
   - Sending sensitive data to external servers
   - Unauthorized POST/PUT requests to remote hosts
   - Environment variable harvesting
   - Process memory inspection

3. **Backdoor Patterns (BCK-001)**
   - Network server creation
   - WebSocket servers
   - Shell spawning
   - Beaconing behavior (periodic callbacks)
   - Suspicious port binding

### 🟠 High Severity (Blocks by Default)

4. **Unsafe Shell Commands (UNC-001)**
   - `rm -rf`, `del /f`, `format`, `fdisk`, `mkfs`
   - `curl | bash` or `wget | bash` patterns
   - Sudo/su escalation
   - Output redirection to system files

5. **Dynamic Code Execution (DYN-001)**
   - `eval()` usage
   - `new Function()` constructor
   - `setTimeout`/`setInterval` with string arguments
   - VM context execution

6. **Obfuscated Code (OBF-001)**
   - Hex escaping (`\x41`)
   - Unicode escaping (`\u0041`)
   - `String.fromCharCode`
   - Base64 encoded payloads
   - Long encoded strings (>200 chars)

7. **File System Risks (FSR-001)**
   - Root directory access (`/etc`, `/usr`, `/bin`)
   - Home directory access
   - Secret/config file reading
   - Dangerous write operations

8. **Unauthorized Access (UAC-001)**
   - `/etc/passwd`, `/etc/shadow` access
   - SSH key harvesting
   - Cloud credential access (AWS_, AZURE_, GCP_)
   - System user enumeration

9. **Prototype Pollution (PPO-001)**
   - `__proto__` manipulation
   - `constructor.prototype` access
   - `applyPrototypeMixins` (forbidden pattern)
   - `Object.defineProperty` on prototypes

### 🟡 Medium Severity (Warning)

10. **Hidden Dependencies (HID-001)**
    - Typosquatting packages (lodash vs. 1odash)
    - Install script tampering
    - Suspicious package names

11. **Environment Manipulation (ENV-001)**
    - Setting process.env variables
    - Deleting environment variables
    - PATH manipulation

12. **Permission Escalation (PER-001)**
    - Sudo commands
    - chmod 777
    - chown root
    - pkexec, gksu, doas

13. **Network Risks (NET-001)**
    - DNS lookup manipulation
    - Suspicious network imports

### 🟢 Low Severity (Logged)

14. **Regex DoS (RED-001)**
    - Nested quantifiers `(a+)*`
    - Catastrophic backtracking patterns

## Usage

### Audit a Local Skill

```bash
# Full audit
openclaw skill-audit scan ./my-skill

# Quick screen (critical/high only)
openclaw skill-audit scan ./my-skill --quick

# With detailed output
openclaw skill-audit scan ./my-skill --verbose
```

### Import from GitHub (Mandatory Audit)

```bash
# Import with full audit
openclaw skill-audit import-github https://github.com/user/skill-repo

# Allow medium severity (use with caution)
openclaw skill-audit import-github https://github.com/user/skill-repo --allow-medium
```

### Browse Collections

```bash
# View available collections
openclaw skills browse

# Shows:
# 📚 Available Skill Collections
# ===============================
# 📦 awesome-openclaw-skills
#    Curated list of excellent OpenClaw skills
#    URL: https://github.com/VoltAgent/awesome-openclaw-skills
#    Trust: medium
```

### Import Recommended Skills

```bash
# Import all recommended skills (each audited individually)
openclaw skills import-recommended

# Allow medium severity findings
openclaw skills import-recommended --allow-medium

# Parallel import (faster, less feedback)
openclaw skills import-recommended --parallel
```

### List Installed Skills

```bash
openclaw skills list

# Output:
# 📦 Installed Skills: 4
# ================================
# ✅ claude-context-mode
#    By: mksglu | Category: context-management
#    Status: verified | Audit: passed
#    Last Audit: 2026-03-03T12:34:56Z
#
# ✅ qmd
#    By: tobi | Category: markdown
#    Status: verified | Audit: passed
```

### Generate Audit Report

```bash
# Console output
openclaw skills audit-report

# Save to file
openclaw skills audit-report --output skill-audit-report.md
```

## Programmatic API

### Basic Usage

```typescript
import { SkillAuditor, SafeSkillImporter } from '@openclaw/ecc-integration';

// Create auditor
const auditor = new SkillAuditor();

// Audit a skill
const result = await auditor.auditSkill('./skill-path');

if (!result.passed) {
  console.error('Skill failed security audit:');
  for (const finding of result.findings) {
    console.error(`  [${finding.severity}] ${finding.title}`);
  }
}
```

### Safe Import with ECC Integration

```typescript
import ECCIntegration from '@openclaw/ecc-integration';

const system = new ECCIntegration();
await system.initialize();

// Import with mandatory audit
const result = await system.importSkillFromGitHub(
  'https://github.com/mksglu/claude-context-mode'
);

if (result.success) {
  console.log(`Installed: ${result.skillName}`);
} else {
  console.error(`Blocked: ${result.error}`);
}
```

### Collection Management

```typescript
// Import recommended collection
const result = await system.importRecommendedSkills();

console.log(`Imported ${result.imported} of ${result.totalSkills} skills`);

// Browse collections
await system.browseSkillCollections();

// Generate report
const report = await system.generateSkillAuditReport();
```

## Audit Report Format

```markdown
# Skill Collection Security Audit Report

Generated: 2026-03-03T12:34:56Z
Total Skills: 4

## Installed Skills

### claude-context-mode
- **Description**: Context mode management for Claude Code
- **Source**: https://github.com/mksglu/claude-context-mode
- **Author**: mksglu
- **Verified**: ✅ Yes
- **Audit Status**: ✅ PASSED
- **Findings**: 0C / 0H / 0M / 0L

### agent-skill-creator
- **Description**: Create skills from code patterns
- **Source**: https://github.com/FrancyJGLisboa/agent-skill-creator
- **Author**: FrancyJGLisboa
- **Verified**: ✅ Yes
- **Audit Status**: ⚠️ PASSED (with warnings)
- **Findings**: 0C / 0H / 2M / 1L

#### Security Findings
**[MEDIUM]** HID-001: Hidden or Suspicious Dependencies
- Category: hidden_dependency
- Location: package.json:15
- Package "rc" appears to be typosquatting "react"
- Remediation: Use the correct package
```

## Configuration

### Trusted Domains

```typescript
const auditor = new SkillAuditor({
  trustedDomains: [
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'raw.githubusercontent.com'
  ]
});
```

### Custom Security Patterns

```typescript
import { SECURITY_PATTERNS } from '@openclaw/ecc-integration';

const customPatterns = [
  ...SECURITY_PATTERNS,
  {
    id: 'CUSTOM-001',
    category: 'company_policy',
    severity: 'high',
    title: 'Prohibited API Usage',
    description: 'Use of prohibited internal APIs',
    remediation: 'Use approved API wrapper',
    codePatterns: [/internalAPI\.call\s*\(/i],
    importPatterns: [],
  }
];

const auditor = new SkillAuditor({ patterns: customPatterns });
```

## Integration with CI/CD

```yaml
# .github/workflows/skill-audit.yml
name: Skill Security Audit

on:
  pull_request:
    paths:
      - 'skills/**'

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Audit Skills
        run: |
          for skill in skills/*/; do
            echo "Auditing $skill..."
            npx openclaw skill-audit scan "$skill" || exit 1
          done
```

## Best Practices

### 1. Always Audit Before Install

```bash
# ❌ Bad - Direct install
npm install some-random-skill

# ✅ Good - Audit first
openclaw skill-audit scan ./downloaded-skill
openclaw skill-audit import-github https://github.com/verified/skill
```

### 2. Use Trusted Sources

- Prefer official OpenClaw collections
- Verify GitHub repository reputation
- Check contributor history
- Review recent commits

### 3. Regular Re-auditing

```bash
# Weekly re-audit of all skills
openclaw skills audit-report --output weekly-audit.md
```

### 4. Quarantine Suspicious Skills

```typescript
const importer = new SafeSkillImporter(auditor, {
  quarantinePath: './quarantine'
});

// Automatically quarantines on critical findings
```

### 5. Monitor Audit Logs

All audits are logged with:
- Timestamp
- Skill source
- Finding details
- Remediation steps

## Troubleshooting

### Audit Too Strict?

```bash
# Check specific severity level
openclaw skill-audit scan ./skill --severity-threshold=high

# Allow specific categories
openclaw skill-audit scan ./skill --allow-categories=network_risk,env_manipulation
```

### False Positives?

If legitimate code is flagged:

1. Review the finding carefully
2. Check if code can be rewritten more safely
3. Use inline annotations to suppress (with approval):
   ```typescript
   // skill-audit-ignore-next-line DYN-001
   eval(safeInput);  // Validated above
   ```

### Audit Performance

For large skill collections:

```bash
# Parallel auditing (faster, uses more CPU)
openclaw skills import-recommended --parallel

# Quick screening first
openclaw skill-audit scan ./skill --quick
```

## Security Checklist

Before installing any skill:

- [ ] Source is from trusted domain (GitHub, GitLab)
- [ ] Repository has active maintenance
- [ ] Audit passed with 0 critical/high findings
- [ ] Medium findings reviewed and justified
- [ ] No typosquatting dependencies
- [ ] No dynamic code execution (eval, new Function)
- [ ] No unauthorized file system access
- [ ] No data exfiltration patterns

## Command Reference

| Command | Description |
|---------|-------------|
| `skill-audit scan <path>` | Full security audit |
| `skill-audit scan --quick` | Quick critical/high screen |
| `skill-audit import-github <url>` | Import with audit |
| `skills browse` | List collections |
| `skills import-recommended` | Import curated skills |
| `skills list` | Show installed skills |
| `skills audit-report` | Generate report |
| `skills validate <name>` | Re-audit skill |
| `skills remove <name>` | Remove skill |

## Integration with Three Core Rules

The Skill Auditor enforces your governance rules:

1. **Rules > Freedom**: All skill imports must pass mandatory security rules
2. **One Agent/One Task**: Each skill audit is an isolated, single task
3. **Claude Code Integration**: Audit results feed into ECC learning system

## Support

For security concerns or false positives:
- Report issues: https://github.com/openclaw/openclaw/issues
- Security advisories: See SECURITY.md

---

**Remember**: Security is not optional. The Skill Auditor is mandatory and cannot be disabled for external skill imports.
