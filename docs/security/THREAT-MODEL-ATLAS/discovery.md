---
summary: "OpenClaw discovery threats (AML.TA0008): T-DISC-001, T-DISC-002"
title: "Discovery (AML.TA0008)"
read_when:
  - Reviewing discovery threats against an OpenClaw deployment
  - Working on mitigations for T-DISC-001, T-DISC-002
---

Threats in the discovery tactic (AML.TA0008) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-DISC-001: Tool enumeration

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker enumerates available tools through prompting |
| **Attack vector**       | "What tools do you have?" style queries               |
| **Affected components** | Agent tool registry                                   |
| **Current mitigations** | None specific                                         |
| **Residual risk**       | Low - tools are generally documented                  |
| **Recommendations**     | Consider tool visibility controls                     |

## T-DISC-002: Session data extraction

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access               |
| **Description**         | Attacker extracts sensitive data from session context   |
| **Attack vector**       | "What did we discuss?" queries, context probing         |
| **Affected components** | Session transcripts, context window                     |
| **Current mitigations** | Session isolation per sender (`agent:channel:peer` key) |
| **Residual risk**       | Medium - within-session data is accessible by design    |
| **Recommendations**     | Sensitive-data redaction in context                     |
