---
summary: "OpenClaw reconnaissance threats (AML.TA0002): T-RECON-001, T-RECON-002"
title: "Reconnaissance (AML.TA0002)"
read_when:
  - Reviewing reconnaissance threats against an OpenClaw deployment
  - Working on mitigations for T-RECON-001, T-RECON-002
---

Threats in the reconnaissance tactic (AML.TA0002) of the [MITRE ATLAS](https://atlas.mitre.org/) framework. Each entry lists the ATLAS technique, attack vector, affected components, current mitigations, residual risk, and recommendations.

The trust boundaries and data flows these threats cross are defined in the [threat model index](/security/THREAT-MODEL-ATLAS), which also holds the risk matrix, the recommendations summary, and the ATLAS technique mapping.

## T-RECON-001: Agent endpoint discovery

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |
| **Description**         | Attacker scans for exposed OpenClaw gateway endpoints                |
| **Attack vector**       | Network scanning, Shodan queries, DNS enumeration                    |
| **Affected components** | Gateway, exposed API endpoints                                       |
| **Current mitigations** | Tailscale auth option, bind to loopback by default                   |
| **Residual risk**       | Medium - public gateways discoverable                                |
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |

## T-RECON-002: Channel integration probing

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                        |
| **Description**         | Attacker probes messaging channels to identify AI-managed accounts |
| **Attack vector**       | Sending test messages, observing response patterns                 |
| **Affected components** | All channel integrations                                           |
| **Current mitigations** | None specific                                                      |
| **Residual risk**       | Low - limited value from discovery alone                           |
| **Recommendations**     | Consider response timing randomization                             |
