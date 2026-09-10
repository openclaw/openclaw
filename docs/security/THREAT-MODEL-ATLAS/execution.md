---
summary: "OpenClaw execution threats (AML.TA0005): T-EXEC-001, T-EXEC-002, T-EXEC-003, T-EXEC-004"
title: "Execution (AML.TA0005)"
read_when:
  - Reviewing execution threats against an OpenClaw deployment
  - Working on mitigations for T-EXEC-001, T-EXEC-002, T-EXEC-003, T-EXEC-004
---

Threats in the execution tactic (AML.TA0005) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-EXEC-001: Direct prompt injection

| Attribute               | Value                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                                                                                                                                                                                                                                                     |
| **Description**         | Attacker sends crafted prompts to manipulate agent behavior                                                                                                                                                                                                                                      |
| **Attack vector**       | Channel messages containing adversarial instructions                                                                                                                                                                                                                                             |
| **Affected components** | Agent LLM, all input surfaces                                                                                                                                                                                                                                                                    |
| **Current mitigations** | Pattern detection, external content wrapping, and frontier-model robustness (2026 crowdsourced arena: 0.5% ASR on Claude Opus 4.5, 8.5% on Gemini 2.5 Pro, scored on execution plus concealment); treated as out-of-scope for vulnerability reports absent a boundary bypass (see `SECURITY.md`) |
| **Residual risk**       | Model-tier dependent - low single-digit ASR against organic attacks on recommended frontier models, but adaptive attackers still exceed 80% against state-of-the-art defenses, and smaller/older models remain markedly easier to steer                                                          |
| **Recommendations**     | Output validation and user confirmation for sensitive actions, layered on top of existing detection                                                                                                                                                                                              |

## T-EXEC-002: Indirect prompt injection

| Attribute               | Value                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.001 - LLM Prompt Injection: Indirect                                                                                                                                                                     |
| **Description**         | Attacker embeds malicious instructions in fetched content                                                                                                                                                          |
| **Attack vector**       | Malicious URLs, poisoned emails, compromised webhooks                                                                                                                                                              |
| **Affected components** | `web_fetch`, email ingestion, external data sources                                                                                                                                                                |
| **Current mitigations** | Content wrapping with random-boundary XML-style markers, homoglyph/special-token normalization, a security notice, and frontier-model robustness (see T-EXEC-001)                                                  |
| **Residual risk**       | Model-tier dependent - recommended frontier models largely hold the wrapper boundary, but it remains soft guidance an adaptive attacker can erode; scope tool policy and sandboxing to the blast radius you accept |
| **Recommendations**     | Separate execution contexts for wrapped content                                                                                                                                                                    |

## T-EXEC-003: Tool argument injection

| Attribute               | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                 |
| **Description**         | Attacker manipulates tool arguments through prompt injection |
| **Attack vector**       | Crafted prompts that influence tool parameter values         |
| **Affected components** | All tool invocations                                         |
| **Current mitigations** | Exec approvals for dangerous commands                        |
| **Residual risk**       | High - relies on user judgment                               |
| **Recommendations**     | Argument validation, parameterized tool calls                |

## T-EXEC-004: Exec approval bypass

| Attribute               | Value                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                                                                                                                                |
| **Description**         | Attacker crafts commands that bypass the approval allowlist                                                                                                                       |
| **Attack vector**       | Command obfuscation, alias exploitation, path manipulation                                                                                                                        |
| **Affected components** | `src/infra/exec-approvals*.ts`, command allowlist                                                                                                                                 |
| **Current mitigations** | Allowlist + ask mode, plus command normalization (dispatch-wrapper unwrapping, inline-eval detection, shell-chain analysis)                                                       |
| **Residual risk**       | High - normalization narrows but does not eliminate obfuscation bypass; parity-only findings between exec paths are treated as hardening, not vulnerabilities (see `SECURITY.md`) |
| **Recommendations**     | Continue expanding command-normalization coverage against new obfuscation techniques                                                                                              |
