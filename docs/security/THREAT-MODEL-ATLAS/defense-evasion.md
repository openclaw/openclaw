---
summary: "OpenClaw defense evasion threats (AML.TA0007): T-EVADE-001, T-EVADE-002"
title: "Defense evasion (AML.TA0007)"
read_when:
  - Reviewing defense evasion threats against an OpenClaw deployment
  - Working on mitigations for T-EVADE-001, T-EVADE-002
---

Threats in the defense evasion tactic (AML.TA0007) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-EVADE-001: Moderation pattern bypass

| Attribute               | Value                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                                    |
| **Description**         | Attacker crafts skill content to evade ClawHub moderation checks                      |
| **Attack vector**       | Unicode homoglyphs, encoding tricks, dynamic loading                                  |
| **Affected components** | ClawHub moderation/scanning pipeline                                                  |
| **Current mitigations** | Static pattern rules, AST-adjacent code scanning, LLM agentic-risk review, VirusTotal |
| **Residual risk**       | Medium - novel obfuscation can still slip past layered heuristics                     |
| **Recommendations**     | Continue expanding the pattern/behavioral corpus as new evasions are found            |

## T-EVADE-002: Content wrapper escape

| Attribute               | Value                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                                                            |
| **Description**         | Attacker crafts content that escapes the external-content wrapper context                                     |
| **Attack vector**       | Tag manipulation, context confusion, instruction override                                                     |
| **Affected components** | External content wrapping                                                                                     |
| **Current mitigations** | Random-boundary XML-style markers + security notice, plus homoglyph/whitespace-variant marker-spoof detection |
| **Residual risk**       | Medium - novel escapes discovered regularly                                                                   |
| **Recommendations**     | Output-side validation in addition to input-side wrapping                                                     |
