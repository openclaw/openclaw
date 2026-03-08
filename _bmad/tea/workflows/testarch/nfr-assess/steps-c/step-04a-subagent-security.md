---
name: "step-04a-subagent-security"
description: "Subagent: Security NFR assessment"
subagent: true
outputFile: "/tmp/tea-nfr-security-{{timestamp}}.json"
---

# Subagent 4A: Security NFR Assessment

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with other NFR domain assessments.

**Your task:** Assess SECURITY NFR domain only.

---

## MANDATORY EXECUTION RULES

- ✅ Assess SECURITY only (not performance, reliability, scalability)
- ✅ Output structured JSON to temp file
- ❌ Do NOT assess other NFR domains

---

## SUBAGENT TASK

### 1. Security Assessment Categories

**Assess the following security dimensions:**

**A) Authentication & Authorization:**

- OAuth2/JWT implementation
- Session management
- Multi-factor authentication
- Role-based access control (RBAC)

**B) Data Protection:**

- Encryption at rest
- Encryption in transit (HTTPS/TLS)
- Sensitive data handling (PII, passwords)
- Database encryption

**C) Input Validation:**

- SQL injection prevention
- XSS prevention
- CSRF protection
- Input sanitization

**D) API Security:**

- Rate limiting
- API authentication
- CORS configuration
- Security headers

**E) Secrets Management:**

- Environment variables for secrets
- No hardcoded credentials
- Secret rotation policies
- Key management systems

### 2. Risk Assessment

For each category, determine status:

- **PASS**: Properly implemented
- **CONCERN**: Partially implemented or weak
- **FAIL**: Not implemented or critical vulnerability
- **N/A**: Not applicable to this system

### 3. Compliance Check

**Common compliance standards:**

- SOC2
- GDPR
- HIPAA
- PCI-DSS
- ISO 27001

---

## OUTPUT FORMAT

```json
{
  "domain": "security",
  "risk_level": "MEDIUM",
  "findings": [
    {
      "category": "Authentication",
      "status": "PASS",
      "description": "OAuth2 with JWT tokens implemented",
      "evidence": ["src/auth/oauth.ts", "JWT refresh token rotation"],
      "recommendations": []
    },
    {
      "category": "Data Encryption",
      "status": "CONCERN",
      "description": "Database encryption at rest not enabled",
      "evidence": ["Database config shows no encryption"],
      "recommendations": [
        "Enable database encryption at rest",
        "Use AWS RDS encryption or equivalent",
        "Implement key rotation policy"
      ]
    },
    {
      "category": "Input Validation",
      "status": "FAIL",
      "description": "SQL injection vulnerability in search endpoint",
      "evidence": ["src/api/search.ts:42 - direct SQL concatenation"],
      "recommendations": [
        "URGENT: Use parameterized queries",
        "Add input sanitization library",
        "Implement WAF rules"
      ]
    }
  ],
  "compliance": {
    "SOC2": "PARTIAL",
    "GDPR": "PASS",
    "HIPAA": "N/A",
    "PCI-DSS": "FAIL"
  },
  "priority_actions": [
    "Fix SQL injection vulnerability (URGENT)",
    "Enable database encryption within 30 days",
    "Implement rate limiting for all APIs"
  ],
  "summary": "Security posture is MEDIUM risk with 1 critical vulnerability requiring immediate attention"
}
```

---

## EXIT CONDITION

Subagent completes when JSON output written to temp file.

**Subagent terminates here.**
