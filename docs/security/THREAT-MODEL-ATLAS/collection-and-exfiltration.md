---
summary: "OpenClaw collection and exfiltration threats (AML.TA0009, AML.TA0010): T-EXFIL-001, T-EXFIL-002, T-EXFIL-003"
title: "Collection and exfiltration (AML.TA0009, AML.TA0010)"
read_when:
  - Reviewing collection and exfiltration threats against an OpenClaw deployment
  - Working on mitigations for T-EXFIL-001, T-EXFIL-002, T-EXFIL-003
---

Threats in the collection and exfiltration tactic (AML.TA0009, AML.TA0010) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-EXFIL-001: Data theft via web_fetch

| Attribute               | Value                                                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                           |
| **Description**         | Attacker exfiltrates data by instructing the agent to send it to an external URL |
| **Attack vector**       | Prompt injection causing the agent to POST data to an attacker server            |
| **Affected components** | `web_fetch` tool                                                                 |
| **Current mitigations** | SSRF blocking for internal/private networks (DNS pinning + IP blocking)          |
| **Residual risk**       | High - arbitrary external URLs remain permitted                                  |
| **Recommendations**     | URL allowlisting, data-classification awareness                                  |

## T-EXFIL-002: Unauthorized message sending

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                               |
| **Description**         | Attacker causes the agent to send messages containing sensitive data |
| **Attack vector**       | Prompt injection causing the agent to message the attacker           |
| **Affected components** | Message tool, channel integrations                                   |
| **Current mitigations** | Outbound messaging gating                                            |
| **Residual risk**       | Medium - gating may be bypassed                                      |
| **Recommendations**     | Explicit confirmation for new recipients                             |

## T-EXFIL-003: Credential harvesting

| Attribute               | Value                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                                                                                                  |
| **Description**         | Malicious skill harvests credentials from the agent context                                                                                             |
| **Attack vector**       | Skill code reads environment variables, config files                                                                                                    |
| **Affected components** | Skill execution environment                                                                                                                             |
| **Current mitigations** | ClawHub credential-pattern scanning (hardcoded secrets, credential env access paired with network sends); no execution sandboxing for skills at runtime |
| **Residual risk**       | Critical - skills run with agent privileges                                                                                                             |
| **Recommendations**     | Skill execution sandboxing, credential isolation                                                                                                        |
