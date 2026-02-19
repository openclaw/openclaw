# Operation Winter Shield

OpenClaw implements FBI's Operation Winter Shield top 10 security mitigations.

## Overview

Operation Winter Shield is a first-of-its-kind campaign highlighting the top 10 things adversaries continue to exploit. The tools help assess your organization against these controls and guide implementation.

## Top 10 Controls

1. **MFA** - Multi-factor authentication
2. **Credential Hygiene** - Strong passwords, credential rotation
3. **Patch Management** - Timely patching of vulnerabilities
4. **Network Segmentation** - Isolating critical systems
5. **Access Controls** - Least privilege access
6. **Monitoring** - Security monitoring and alerting
7. **Incident Response** - Prepared response procedures
8. **Backup Recovery** - Regular backups and recovery testing
9. **Supply Chain** - Supply chain security
10. **Training** - Security awareness training

## Tools

### `security_assess_wintershield`

Assess your organization against Operation Winter Shield top 10. Generates a prioritized remediation report.

**Example:**

```
security_assess_wintershield({})
```

### `security_mitigate_wintershield`

Apply Winter Shield mitigations. Guides through implementing each of the 10 controls and tracks implementation status.

**Example:**

```
security_mitigate_wintershield({
  control: "mfa"
})
```

## Configuration

Enable Winter Shield assessment in your config:

```json5
{
  cybersecurity: {
    wintershield: {
      enabled: true,
      assessmentInterval: "7d"
    }
  }
}
```

## Resources

- FBI Winter Shield: <https://fbi.gov/wintershield>
- FBI Cyber Division Twitter: @FBICyber
