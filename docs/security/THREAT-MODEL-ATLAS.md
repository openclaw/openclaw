# OpenClaw Threat Model v1.0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## MITRE ATLAS Framework（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Version:** 1.0-draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Last Updated:** 2026-02-04（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Methodology:** MITRE ATLAS + Data Flow Diagrams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Framework Attribution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/), the industry-standard framework for documenting adversarial threats to AI/ML systems. ATLAS is maintained by [MITRE](https://www.mitre.org/) in collaboration with the AI security community.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key ATLAS Resources:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS Techniques](https://atlas.mitre.org/techniques/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS Tactics](https://atlas.mitre.org/tactics/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS GitHub](https://github.com/mitre-atlas/atlas-data)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Contributing to ATLAS](https://atlas.mitre.org/resources/contribute)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Contributing to This Threat Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is a living document maintained by the OpenClaw community. See [CONTRIBUTING-THREAT-MODEL.md](./CONTRIBUTING-THREAT-MODEL.md) for guidelines on contributing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reporting new threats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updating existing threats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Proposing attack chains（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Suggesting mitigations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1. Introduction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.1 Purpose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This threat model documents adversarial threats to the OpenClaw AI agent platform and ClawHub skill marketplace, using the MITRE ATLAS framework designed specifically for AI/ML systems.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.2 Scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Component              | Included | Notes                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | -------- | ------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| OpenClaw Agent Runtime | Yes      | Core agent execution, tool calls, sessions       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Gateway                | Yes      | Authentication, routing, channel integration     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Channel Integrations   | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ClawHub Marketplace    | Yes      | Skill publishing, moderation, distribution       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| MCP Servers            | Yes      | External tool providers                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| User Devices           | Partial  | Mobile apps, desktop clients                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1.3 Out of Scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nothing is explicitly out of scope for this threat model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2. System Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2.1 Trust Boundaries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                    UNTRUSTED ZONE                                │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│         │                │                │                      │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────┼────────────────┼────────────────┼──────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          │                │                │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ▼                ▼                ▼（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                 TRUST BOUNDARY 1: Channel Access                 │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  ┌──────────────────────────────────────────────────────────┐   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │                      GATEWAY                              │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Device Pairing (30s grace period)                      │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • AllowFrom / AllowList validation                       │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Token/Password/Tailscale auth                          │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  └──────────────────────────────────────────────────────────┘   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              ▼（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                 TRUST BOUNDARY 2: Session Isolation              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  ┌──────────────────────────────────────────────────────────┐   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │                   AGENT SESSIONS                          │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Session key = agent:channel:peer                       │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Tool policies per agent                                │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Transcript logging                                     │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  └──────────────────────────────────────────────────────────┘   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              ▼（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                 TRUST BOUNDARY 3: Tool Execution                 │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  ┌──────────────────────────────────────────────────────────┐   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │                  EXECUTION SANDBOX                        │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Docker sandbox OR Host (exec-approvals)                │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Node remote execution                                  │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • SSRF protection (DNS pinning + IP blocking)            │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  └──────────────────────────────────────────────────────────┘   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              ▼（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                 TRUST BOUNDARY 4: External Content               │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  ┌──────────────────────────────────────────────────────────┐   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │              FETCHED URLs / EMAILS / WEBHOOKS             │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • External content wrapping (XML tags)                   │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Security notice injection                              │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  └──────────────────────────────────────────────────────────┘   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                              ▼（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                 TRUST BOUNDARY 5: Supply Chain                   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  ┌──────────────────────────────────────────────────────────┐   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │                      CLAWHUB                              │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Skill publishing (semver, SKILL.md required)           │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • Pattern-based moderation flags                         │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • VirusTotal scanning (coming soon)                      │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  │  • GitHub account age verification                        │   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│  └──────────────────────────────────────────────────────────┘   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2.2 Data Flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Flow | Source  | Destination | Data               | Protection           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---- | ------- | ----------- | ------------------ | -------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| F1   | Channel | Gateway     | User messages      | TLS, AllowFrom       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| F2   | Gateway | Agent       | Routed messages    | Session isolation    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| F3   | Agent   | Tools       | Tool invocations   | Policy enforcement   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| F4   | Agent   | External    | web_fetch requests | SSRF blocking        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| F5   | ClawHub | Agent       | Skill code         | Moderation, scanning |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| F6   | Agent   | Channel     | Responses          | Output filtering     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3. Threat Analysis by ATLAS Tactic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.1 Reconnaissance (AML.TA0002)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-RECON-001: Agent Endpoint Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker scans for exposed OpenClaw gateway endpoints                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Network scanning, shodan queries, DNS enumeration                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Gateway, exposed API endpoints                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Tailscale auth option, bind to loopback by default                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Public gateways discoverable                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-RECON-002: Channel Integration Probing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0006 - Active Scanning                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker probes messaging channels to identify AI-managed accounts |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Sending test messages, observing response patterns                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | All channel integrations                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | None specific                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Low - Limited value from discovery alone                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Consider response timing randomization                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.2 Initial Access (AML.TA0004)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-ACCESS-001: Pairing Code Interception（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker intercepts pairing code during 30s grace period |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Shoulder surfing, network sniffing, social engineering   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Device pairing system                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | 30s expiry, codes sent via existing channel              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Grace period exploitable                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Reduce grace period, add confirmation step               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-ACCESS-002: AllowFrom Spoofing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker spoofs allowed sender identity in channel                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Depends on channel - phone number spoofing, username impersonation             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | AllowFrom validation per channel                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Channel-specific identity verification                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Some channels vulnerable to spoofing                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Document channel-specific risks, add cryptographic verification where possible |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-ACCESS-003: Token Theft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker steals authentication tokens from config files     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Malware, unauthorized device access, config backup exposure |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | ~/.openclaw/credentials/, config storage                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | File permissions                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - Tokens stored in plaintext                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement token encryption at rest, add token rotation      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.3 Execution (AML.TA0005)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXEC-001: Direct Prompt Injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker sends crafted prompts to manipulate agent behavior                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Channel messages containing adversarial instructions                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Agent LLM, all input surfaces                                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Pattern detection, external content wrapping                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Critical - Detection only, no blocking; sophisticated attacks bypass                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement multi-layer defense, output validation, user confirmation for sensitive actions |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXEC-002: Indirect Prompt Injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0051.001 - LLM Prompt Injection: Indirect              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker embeds malicious instructions in fetched content   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Malicious URLs, poisoned emails, compromised webhooks       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | web_fetch, email ingestion, external data sources           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Content wrapping with XML tags and security notice          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - LLM may ignore wrapper instructions                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement content sanitization, separate execution contexts |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXEC-003: Tool Argument Injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker manipulates tool arguments through prompt injection |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Crafted prompts that influence tool parameter values         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | All tool invocations                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Exec approvals for dangerous commands                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - Relies on user judgment                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement argument validation, parameterized tool calls      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXEC-004: Exec Approval Bypass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ---------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker crafts commands that bypass approval allowlist    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Command obfuscation, alias exploitation, path manipulation |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | exec-approvals.ts, command allowlist                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Allowlist + ask mode                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - No command sanitization                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement command normalization, expand blocklist          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.4 Persistence (AML.TA0006)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-PERSIST-001: Malicious Skill Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker publishes malicious skill to ClawHub                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Create account, publish skill with hidden malicious code                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | ClawHub, skill loading, agent execution                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | GitHub account age verification, pattern-based moderation flags          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Critical - No sandboxing, limited review                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | VirusTotal integration (in progress), skill sandboxing, community review |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-PERSIST-002: Skill Update Poisoning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker compromises popular skill and pushes malicious update |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Account compromise, social engineering of skill owner          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | ClawHub versioning, auto-update flows                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Version fingerprinting                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - Auto-updates may pull malicious versions                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement update signing, rollback capability, version pinning |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-PERSIST-003: Agent Configuration Tampering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | --------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0010.002 - Supply Chain Compromise: Data                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker modifies agent configuration to persist access         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Config file modification, settings injection                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Agent config, tool policies                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | File permissions                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Requires local access                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Config integrity verification, audit logging for config changes |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.5 Defense Evasion (AML.TA0007)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EVADE-001: Moderation Pattern Bypass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ---------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker crafts skill content to evade moderation patterns             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Unicode homoglyphs, encoding tricks, dynamic loading                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | ClawHub moderation.ts                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Pattern-based FLAG_RULES                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - Simple regex easily bypassed                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Add behavioral analysis (VirusTotal Code Insight), AST-based detection |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EVADE-002: Content Wrapper Escape（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | --------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker crafts content that escapes XML wrapper context  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Tag manipulation, context confusion, instruction override |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | External content wrapping                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | XML tags + security notice                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Novel escapes discovered regularly               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Multiple wrapper layers, output-side validation           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.6 Discovery (AML.TA0008)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-DISC-001: Tool Enumeration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker enumerates available tools through prompting |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | "What tools do you have?" style queries               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Agent tool registry                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | None specific                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Low - Tools generally documented                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Consider tool visibility controls                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-DISC-002: Session Data Extraction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker extracts sensitive data from session context |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | "What did we discuss?" queries, context probing       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Session transcripts, context window                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Session isolation per sender                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Within-session data accessible               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement sensitive data redaction in context         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXFIL-001: Data Theft via web_fetch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ---------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0009 - Collection                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker exfiltrates data by instructing agent to send to external URL |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Prompt injection causing agent to POST data to attacker server         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | web_fetch tool                                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | SSRF blocking for internal networks                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - External URLs permitted                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement URL allowlisting, data classification awareness              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXFIL-002: Unauthorized Message Sending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ---------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0009 - Collection                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker causes agent to send messages containing sensitive data |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Prompt injection causing agent to message attacker               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Message tool, channel integrations                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Outbound messaging gating                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Gating may be bypassed                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Require explicit confirmation for new recipients                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-EXFIL-003: Credential Harvesting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0009 - Collection                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Malicious skill harvests credentials from agent context |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Skill code reads environment variables, config files    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Skill execution environment                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | None specific to skills                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Critical - Skills run with agent privileges             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Skill sandboxing, credential isolation                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3.8 Impact (AML.TA0011)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-IMPACT-001: Unauthorized Command Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | --------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker executes arbitrary commands on user system |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Prompt injection combined with exec approval bypass |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Bash tool, command execution                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | Exec approvals, Docker sandbox option               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Critical - Host execution without sandbox           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Default to sandbox, improve approval UX             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-IMPACT-002: Resource Exhaustion (DoS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker exhausts API credits or compute resources |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Automated message flooding, expensive tool calls   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Gateway, agent sessions, API provider              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | None                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | High - No rate limiting                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Implement per-sender rate limits, cost budgets     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### T-IMPACT-003: Reputation Damage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Attribute               | Value                                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Description**         | Attacker causes agent to send harmful/offensive content |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attack Vector**       | Prompt injection causing inappropriate responses        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Affected Components** | Output generation, channel messaging                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Current Mitigations** | LLM provider content policies                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Residual Risk**       | Medium - Provider filters imperfect                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Recommendations**     | Output filtering layer, user controls                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4. ClawHub Supply Chain Analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4.1 Current Security Controls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Control              | Implementation              | Effectiveness                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | --------------------------- | ---------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| GitHub Account Age   | `requireGitHubAccountAge()` | Medium - Raises bar for new attackers                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Path Sanitization    | `sanitizePath()`            | High - Prevents path traversal                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File Type Validation | `isTextFile()`              | Medium - Only text files, but can still be malicious |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Size Limits          | 50MB total bundle           | High - Prevents resource exhaustion                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Required SKILL.md    | Mandatory readme            | Low security value - Informational only              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Pattern Moderation   | FLAG_RULES in moderation.ts | Low - Easily bypassed                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Moderation Status    | `moderationStatus` field    | Medium - Manual review possible                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4.2 Moderation Flag Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current patterns in `moderation.ts`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```javascript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Known-bad identifiers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool)/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Suspicious keywords（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(malware|stealer|phish|phishing|keylogger)/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(api[-_ ]?key|token|password|private key|secret)/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(wallet|seed phrase|mnemonic|crypto)/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(discord\.gg|webhook|hooks\.slack)/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(curl[^\n]+\|\s*(sh|bash))/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Limitations:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only checks slug, displayName, summary, frontmatter, metadata, file paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Does not analyze actual skill code content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Simple regex easily bypassed with obfuscation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No behavioral analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4.3 Planned Improvements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Improvement            | Status                                | Impact                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| VirusTotal Integration | In Progress                           | High - Code Insight behavioral analysis                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Community Reporting    | Partial (`skillReports` table exists) | Medium                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Audit Logging          | Partial (`auditLogs` table exists)    | Medium                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Badge System           | Implemented                           | Medium - `highlighted`, `official`, `deprecated`, `redactionApproved` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5. Risk Matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5.1 Likelihood vs Impact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Threat ID     | Likelihood | Impact   | Risk Level   | Priority |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------- | ---------- | -------- | ------------ | -------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-EXEC-001    | High       | Critical | **Critical** | P0       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-PERSIST-001 | High       | Critical | **Critical** | P0       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-EXFIL-003   | Medium     | Critical | **Critical** | P0       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-IMPACT-001  | Medium     | Critical | **High**     | P1       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-EXEC-002    | High       | High     | **High**     | P1       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-EXEC-004    | Medium     | High     | **High**     | P1       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-ACCESS-003  | Medium     | High     | **High**     | P1       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-EXFIL-001   | Medium     | High     | **High**     | P1       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-IMPACT-002  | High       | Medium   | **High**     | P1       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-EVADE-001   | High       | Medium   | **Medium**   | P2       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-ACCESS-001  | Low        | High     | **Medium**   | P2       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-ACCESS-002  | Low        | High     | **Medium**   | P2       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| T-PERSIST-002 | Low        | High     | **Medium**   | P2       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5.2 Critical Path Attack Chains（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Attack Chain 1: Skill-Based Data Theft**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Publish malicious skill) → (Evade moderation) → (Harvest credentials)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Attack Chain 2: Prompt Injection to RCE**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Inject prompt) → (Bypass exec approval) → (Execute commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Attack Chain 3: Indirect Injection via Fetched Content**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
T-EXEC-002 → T-EXFIL-001 → External exfiltration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Poison URL content) → (Agent fetches & follows instructions) → (Data sent to attacker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6. Recommendations Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.1 Immediate (P0)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ID    | Recommendation                              | Addresses                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----- | ------------------------------------------- | -------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-001 | Complete VirusTotal integration             | T-PERSIST-001, T-EVADE-001 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-002 | Implement skill sandboxing                  | T-PERSIST-001, T-EXFIL-003 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-003 | Add output validation for sensitive actions | T-EXEC-001, T-EXEC-002     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.2 Short-term (P1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ID    | Recommendation                           | Addresses    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----- | ---------------------------------------- | ------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-004 | Implement rate limiting                  | T-IMPACT-002 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-005 | Add token encryption at rest             | T-ACCESS-003 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-006 | Improve exec approval UX and validation  | T-EXEC-004   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-007 | Implement URL allowlisting for web_fetch | T-EXFIL-001  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6.3 Medium-term (P2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ID    | Recommendation                                        | Addresses     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----- | ----------------------------------------------------- | ------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-008 | Add cryptographic channel verification where possible | T-ACCESS-002  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-009 | Implement config integrity verification               | T-PERSIST-003 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| R-010 | Add update signing and version pinning                | T-PERSIST-002 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7. Appendices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.1 ATLAS Technique Mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ATLAS ID      | Technique Name                 | OpenClaw Threats                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------- | ------------------------------ | ---------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0006     | Active Scanning                | T-RECON-001, T-RECON-002                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0009     | Collection                     | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0010.001 | Supply Chain: AI Software      | T-PERSIST-001, T-PERSIST-002                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0010.002 | Supply Chain: Data             | T-PERSIST-003                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0031     | Erode AI Model Integrity       | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0040     | AI Model Inference API Access  | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003, T-DISC-001, T-DISC-002 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0043     | Craft Adversarial Data         | T-EXEC-004, T-EVADE-001, T-EVADE-002                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0051.000 | LLM Prompt Injection: Direct   | T-EXEC-001, T-EXEC-003                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| AML.T0051.001 | LLM Prompt Injection: Indirect | T-EXEC-002                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.2 Key Security Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Path                                | Purpose                     | Risk Level   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------------- | --------------------------- | ------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/infra/exec-approvals.ts`       | Command approval logic      | **Critical** |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/gateway/auth.ts`               | Gateway authentication      | **Critical** |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/web/inbound/access-control.ts` | Channel access control      | **Critical** |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/infra/net/ssrf.ts`             | SSRF protection             | **Critical** |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/security/external-content.ts`  | Prompt injection mitigation | **Critical** |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/agents/sandbox/tool-policy.ts` | Tool policy enforcement     | **Critical** |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `convex/lib/moderation.ts`          | ClawHub moderation          | **High**     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `convex/lib/skillPublish.ts`        | Skill publishing flow       | **High**     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `src/routing/resolve-route.ts`      | Session isolation           | **Medium**   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7.3 Glossary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Term                 | Definition                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | --------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ATLAS**            | MITRE's Adversarial Threat Landscape for AI Systems       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **ClawHub**          | OpenClaw's skill marketplace                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Gateway**          | OpenClaw's message routing and authentication layer       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **MCP**              | Model Context Protocol - tool provider interface          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Prompt Injection** | Attack where malicious instructions are embedded in input |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Skill**            | Downloadable extension for OpenClaw agents                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **SSRF**             | Server-Side Request Forgery                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
_This threat model is a living document. Report security issues to security@openclaw.ai_（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
