---
summary: "OpenClaw initial access threats (AML.TA0004): T-ACCESS-001, T-ACCESS-002, T-ACCESS-003"
title: "Initial access (AML.TA0004)"
read_when:
  - Reviewing initial access threats against an OpenClaw deployment
  - Working on mitigations for T-ACCESS-001, T-ACCESS-002, T-ACCESS-003
---

Threats in the initial access tactic (AML.TA0004) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-ACCESS-001: Pairing code interception

| Attribute               | Value                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                                             |
| **Description**         | Attacker intercepts a pairing code during the pairing window (1h DM/generic pairing, 5m node pairing) |
| **Attack vector**       | Shoulder surfing, network sniffing, social engineering                                                |
| **Affected components** | Device pairing system                                                                                 |
| **Current mitigations** | 1h TTL (DM/generic pairing), 5m TTL (node pairing); codes sent via the existing channel               |
| **Residual risk**       | Medium - pairing window exploitable                                                                   |
| **Recommendations**     | Reduce pairing window, add a confirmation step                                                        |

## T-ACCESS-002: AllowFrom spoofing

| Attribute               | Value                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                                                                                                                                                                                                                                                                                   |
| **Description**         | Attacker spoofs an allowed sender identity on a channel                                                                                                                                                                                                                                                                                     |
| **Attack vector**       | Channel-dependent - phone number spoofing, username impersonation                                                                                                                                                                                                                                                                           |
| **Affected components** | Per-channel AllowFrom validation                                                                                                                                                                                                                                                                                                            |
| **Current mitigations** | Channel-specific identity verification; graded identifier-authentication gate uses `min(entry, subject)` over `verified > asserted > unverified > mutable` with exact match provenance and default minimum `asserted` (#123782/#123793). Channels declare per-identifier strength; security audit warns on inert mutable entries (#131129). |
| **Residual risk**       | Medium - some channels remain vulnerable to spoofing                                                                                                                                                                                                                                                                                        |
| **Recommendations**     | Continue per-channel `verified` adoption and downstream strength mappers; document channel-specific risks                                                                                                                                                                                                                                   |

## T-ACCESS-003: Token theft

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                          |
| **Description**         | Attacker steals authentication tokens from config/credential files |
| **Attack vector**       | Malware, unauthorized device access, config backup exposure        |
| **Affected components** | Channel/provider credential storage, config storage                |
| **Current mitigations** | File permissions                                                   |
| **Residual risk**       | High - tokens stored in plaintext on disk                          |
| **Recommendations**     | Implement token encryption at rest, add token rotation             |
