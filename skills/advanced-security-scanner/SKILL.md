# Advanced Security Scanner

Enterprise-grade security analysis for codebases with SAST, SCA, secret detection, and compliance checking.

## Description

Use when: user asks for security audit, vulnerability scan, code security review, dependency check, secret scanning, or compliance verification (OWASP, CWE, PCI-DSS, etc.).

NOT for: runtime security monitoring, penetration testing, or infrastructure hardening.

## Core Capabilities

### 1. Static Application Security Testing (SAST)
- **Multi-language support**: TypeScript, JavaScript, Python, Java, Go, Ruby, PHP, C#
- **20+ vulnerability categories**: SQL injection, XSS, command injection, authentication flaws, cryptographic issues
- **CWE/OWASP mapping**: Automatic mapping to security standards
- **False positive reduction**: Smart pattern matching with anti-patterns

### 2. Software Composition Analysis (SCA)
- **Dependency vulnerability detection**: Scans npm, pip, Maven, Go modules
- **CVE database**: Known vulnerability matching
- **License compliance**: Identifies license issues
- **Transitive dependency analysis**: Deep dependency tree scanning

### 3. Secret Detection
- **15+ secret types**: AWS keys, GitHub tokens, API keys, private keys, database URLs
- **Entropy analysis**: High-entropy string detection
- **Pattern verification**: Smart validation to reduce false positives
- **Safe exclusions**: Skips test files and documentation

### 4. Compliance Checking
- **OWASP Top 10 2021**: Full compliance verification
- **SANS Top 25**: CWE coverage
- **PCI-DSS**: Payment security requirements
- **Custom frameworks**: Extensible compliance checking

## Supported Languages & Frameworks

| Language | Frameworks Scanned | Vulnerabilities Detected |
|----------|-------------------|-------------------------|
| TypeScript/JavaScript | Node.js, React, Express, Next.js | 25+ categories |
| Python | Django, Flask, FastAPI | 20+ categories |
| Java | Spring, Jakarta EE | 18+ categories |
| Go | Standard library, popular frameworks | 15+ categories |
| Ruby | Rails, Sinatra | 12+ categories |
| PHP | Laravel, Symfony | 20+ categories |
| C# | .NET Core, ASP.NET | 15+ categories |

## Usage Examples

### Basic Security Scan
```bash
Scan my project for security vulnerabilities
```

### Focused Scan
```bash
Check src/ directory for SQL injection and XSS vulnerabilities
```

### Compliance Check
```bash
Verify OWASP Top 10 compliance for my application
```

### Secret Detection
```bash
Scan for hardcoded secrets and API keys
```

## Configuration

```yaml
skills:
  advanced-security-scanner:
    # Scan types to run
    scanTypes:
      - sast
      - sca
      - secrets
      - infrastructure
    
    # Severity threshold
    severityThreshold: medium  # critical, high, medium, low
    
    # Compliance frameworks
    compliance:
      - owasp-top-10
      - sans-top-25
      - cwe-top-25
    
    # Exclusions
    exclude:
      - "**/node_modules/**"
      - "**/dist/**"
      - "**/.git/**"
      - "**/test/**"
    
    # Output formats
    outputFormats:
      - markdown
      - sarif
      - json
```

## Output Formats

### 1. Markdown Report
Human-readable security report with severity breakdown, findings, and remediation steps.

### 2. SARIF (Static Analysis Results Interchange Format)
GitHub Security integration for automated code scanning alerts.

### 3. JSON
Machine-readable format for CI/CD pipeline integration.

### 4. HTML
Rich interactive report with charts and filtering.

## Security Rules Database

**Total Rules**: 50+ comprehensive security rules

### Categories:
- **Injection Flaws** (10 rules): SQL, NoSQL, Command, LDAP, XPath
- **Authentication** (5 rules): Hardcoded credentials, weak hashing
- **Cryptography** (6 rules): Weak algorithms, insecure random
- **Access Control** (4 rules): Path traversal, broken authorization
- **Data Exposure** (5 rules): Sensitive data logging, information leakage
- **Configuration** (8 rules): XXE, insecure deserialization, SSRF
- **Code Quality** (12 rules): Race conditions, ReDoS, prototype pollution

## CI/CD Integration

### GitHub Actions
```yaml
- name: Security Scan
  run: openclaw skills/advanced-security-scanner --output sarif
- name: Upload to GitHub Security
  uses: github/codeql-action/upload-sarif@v2
  with:
    sarif_file: security-report.sarif
```

### GitLab CI
```yaml
security_scan:
  script:
    - openclaw skills/advanced-security-scanner --format json
  artifacts:
    reports:
      sast: security-report.json
```

## Best Practices

1. **Run before every commit**: Pre-commit hook integration
2. **Block critical findings**: Fail CI/CD on critical vulnerabilities
3. **Review regularly**: Weekly full scans
4. **Customize rules**: Add domain-specific security patterns
5. **Track metrics**: Monitor security debt over time

## Limitations

- Static analysis only (no runtime analysis)
- May produce false positives (review recommended)
- Custom frameworks may need additional rules
- Encrypted/obfuscated code analysis limited

## Related Skills

- `github`: Create security issues from findings
- `ai-code-reviewer`: Combine with code quality review
- `coding-agent`: Auto-fix detected vulnerabilities
