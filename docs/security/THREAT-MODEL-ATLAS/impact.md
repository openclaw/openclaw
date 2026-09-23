---
summary: "OpenClaw impact threats (AML.TA0011): T-IMPACT-001, T-IMPACT-002, T-IMPACT-003"
title: "Impact (AML.TA0011)"
read_when:
  - Reviewing impact threats against an OpenClaw deployment
  - Working on mitigations for T-IMPACT-001, T-IMPACT-002, T-IMPACT-003
---

Threats in the impact tactic (AML.TA0011) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-IMPACT-001: Unauthorized command execution

| Attribute               | Value                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                                                                 |
| **Description**         | Attacker executes arbitrary commands on the user system                                              |
| **Attack vector**       | Prompt injection combined with exec approval bypass                                                  |
| **Affected components** | Bash tool, command execution                                                                         |
| **Current mitigations** | Exec approvals, Docker sandbox option (default runtime backend)                                      |
| **Residual risk**       | Critical - host execution possible when sandbox is disabled                                          |
| **Recommendations**     | Improve approval UX; sandbox-off deployments remain a deliberate operator choice, documented as such |

## T-IMPACT-002: Resource exhaustion (DoS)

| Attribute               | Value                                              |
| ----------------------- | -------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity               |
| **Description**         | Attacker exhausts API credits or compute resources |
| **Attack vector**       | Automated message flooding, expensive tool calls   |
| **Affected components** | Gateway, agent sessions, API provider              |
| **Current mitigations** | None                                               |
| **Residual risk**       | High - no per-sender rate limiting                 |
| **Recommendations**     | Per-sender rate limits, cost budgets               |

## T-IMPACT-003: Reputation damage

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                        |
| **Description**         | Attacker causes the agent to send harmful/offensive content |
| **Attack vector**       | Prompt injection causing inappropriate responses            |
| **Affected components** | Output generation, channel messaging                        |
| **Current mitigations** | LLM provider content policies                               |
| **Residual risk**       | Medium - provider filters are imperfect                     |
| **Recommendations**     | Output filtering layer, user controls                       |
