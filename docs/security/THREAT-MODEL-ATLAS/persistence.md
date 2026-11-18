---
summary: "OpenClaw persistence threats (AML.TA0006): T-PERSIST-001, T-PERSIST-002, T-PERSIST-003"
title: "Persistence (AML.TA0006)"
read_when:
  - Reviewing persistence threats against an OpenClaw deployment
  - Working on mitigations for T-PERSIST-001, T-PERSIST-002, T-PERSIST-003
---

Threats in the persistence tactic (AML.TA0006) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-PERSIST-001: Malicious skill installation

| Attribute               | Value                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                                                                      |
| **Description**         | Attacker publishes a malicious skill to ClawHub                                                                           |
| **Attack vector**       | Create account, publish skill with hidden malicious code                                                                  |
| **Affected components** | ClawHub, skill loading, agent execution                                                                                   |
| **Current mitigations** | GitHub account age verification, static pattern/AST-adjacent scanning, LLM-based agentic risk review, VirusTotal scanning |
| **Residual risk**       | High - detection layers exist but skills still run with agent privileges and no execution sandboxing                      |
| **Recommendations**     | Skill execution sandboxing, expanded community review                                                                     |

## T-PERSIST-002: Skill update poisoning

| Attribute               | Value                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                    |
| **Description**         | Attacker compromises a popular skill and pushes a malicious update      |
| **Attack vector**       | Account compromise, social engineering of skill owner                   |
| **Affected components** | ClawHub versioning, auto-update flows                                   |
| **Current mitigations** | Version fingerprinting, moderation/scanning re-run on new versions      |
| **Residual risk**       | High - auto-updates may pull malicious versions before review completes |
| **Recommendations**     | Update signing, rollback capability, version pinning                    |

## T-PERSIST-003: Agent configuration tampering

| Attribute               | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.002 - Supply Chain Compromise: Data                   |
| **Description**         | Attacker modifies agent configuration to persist access         |
| **Attack vector**       | Config file modification, settings injection                    |
| **Affected components** | Agent config, tool policies                                     |
| **Current mitigations** | File permissions                                                |
| **Residual risk**       | Medium - requires local access                                  |
| **Recommendations**     | Config integrity verification, audit logging for config changes |
