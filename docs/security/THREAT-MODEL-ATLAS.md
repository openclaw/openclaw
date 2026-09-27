---
summary: "OpenClaw threat model mapped to the MITRE ATLAS framework"
title: "Threat model (MITRE ATLAS)"
read_when:
  - Reviewing security posture or threat scenarios
  - Working on security features or audit responses
---

**Version:** 1.0-draft | **Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems) + data flow diagrams

This threat model documents adversarial threats to the OpenClaw AI agent platform and ClawHub skill marketplace. It is a living document maintained by the OpenClaw community. See [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL) for how to report new threats, propose attack chains, or suggest mitigations.

**Key ATLAS resources:** [ATLAS website](https://atlas.mitre.org/) | [ATLAS data and contribution guide](https://github.com/mitre-atlas/atlas-data)

---

## 1. Scope

| Component              | Included | Notes                                            |
| ---------------------- | -------- | ------------------------------------------------ |
| OpenClaw agent runtime | Yes      | Core agent execution, tool calls, sessions       |
| Gateway                | Yes      | Authentication, routing, channel integration     |
| Channel integrations   | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |
| ClawHub marketplace    | Yes      | Skill publishing, moderation, distribution       |
| MCP servers            | Yes      | External tool providers                          |
| User devices           | Partial  | Mobile apps, desktop clients                     |

Out-of-scope reports and false-positive patterns (public internet exposure, prompt-injection-only chains without a boundary bypass, mutually untrusted operators sharing one gateway host, and others) are enumerated in [`SECURITY.md`](https://github.com/openclaw/openclaw/blob/main/SECURITY.md); that file is the current source of truth for vulnerability-report scope, not this page.

## 2. System architecture

### 2.1 Trust boundaries

```text
┌─────────────────────────────────────────────────────────────────┐
│                    UNTRUSTED ZONE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 1: Channel Access                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      GATEWAY                              │   │
│  │  • Device pairing (1h DM pairing / 5m node pairing TTL)   │   │
│  │  • AllowFrom / allowlist validation                       │   │
│  │  • Token / password / Tailscale auth                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 2: Session Isolation              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   AGENT SESSIONS                          │   │
│  │  • Session key = agent:channel:peer                       │   │
│  │  • Tool policies per agent                                │   │
│  │  • Transcript logging                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 3: Tool Execution                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  EXECUTION SANDBOX                        │   │
│  │  • Docker sandbox (default) or host (exec approvals)      │   │
│  │  • Node remote execution                                  │   │
│  │  • SSRF protection (DNS pinning + IP blocking)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 4: External Content               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              FETCHED URLs / EMAILS / WEBHOOKS             │   │
│  │  • External content wrapping (random-boundary XML tags)   │   │
│  │  • Security notice injection                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 5: Supply Chain                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      CLAWHUB                              │   │
│  │  • Skill publishing (semver, SKILL.md required)           │   │
│  │  • Static pattern + AST-adjacent moderation scanning      │   │
│  │  • LLM-based agentic risk review + VirusTotal scanning    │   │
│  │  • GitHub account age verification (14 days)              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data flows

| Flow | Source  | Destination | Data                 | Protection           |
| ---- | ------- | ----------- | -------------------- | -------------------- |
| F1   | Channel | Gateway     | User messages        | TLS, AllowFrom       |
| F2   | Gateway | Agent       | Routed messages      | Session isolation    |
| F3   | Agent   | Tools       | Tool invocations     | Policy enforcement   |
| F4   | Agent   | External    | `web_fetch` requests | SSRF blocking        |
| F5   | ClawHub | Agent       | Skill code           | Moderation, scanning |
| F6   | Agent   | Channel     | Responses            | Output filtering     |

---

## 3. Threat analysis by ATLAS tactic

The threat catalog is split by ATLAS tactic. Each page below holds the full attribute table for every threat in that tactic. The risk matrix in section 5 and the recommendations summary in section 6 index across all of them, and the ATLAS technique mapping in section 7.1 lists which threats implement each technique.

| ATLAS tactic                                         | Threats                                        | Page                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Reconnaissance (AML.TA0002)                          | T-RECON-001, T-RECON-002                       | [Reconnaissance](/security/THREAT-MODEL-ATLAS/reconnaissance)                           |
| Initial access (AML.TA0004)                          | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003       | [Initial access](/security/THREAT-MODEL-ATLAS/initial-access)                           |
| Execution (AML.TA0005)                               | T-EXEC-001, T-EXEC-002, T-EXEC-003, T-EXEC-004 | [Execution](/security/THREAT-MODEL-ATLAS/execution)                                     |
| Persistence (AML.TA0006)                             | T-PERSIST-001, T-PERSIST-002, T-PERSIST-003    | [Persistence](/security/THREAT-MODEL-ATLAS/persistence)                                 |
| Defense evasion (AML.TA0007)                         | T-EVADE-001, T-EVADE-002                       | [Defense evasion](/security/THREAT-MODEL-ATLAS/defense-evasion)                         |
| Discovery (AML.TA0008)                               | T-DISC-001, T-DISC-002                         | [Discovery](/security/THREAT-MODEL-ATLAS/discovery)                                     |
| Collection and exfiltration (AML.TA0009, AML.TA0010) | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003          | [Collection and exfiltration](/security/THREAT-MODEL-ATLAS/collection-and-exfiltration) |
| Impact (AML.TA0011)                                  | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003       | [Impact](/security/THREAT-MODEL-ATLAS/impact)                                           |

---

## 4. ClawHub supply chain analysis

### 4.1 Current security controls

| Control                        | Implementation                                                                        | Effectiveness                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GitHub account age             | `requireGitHubAccountAge()` (14-day minimum)                                          | Medium - raises the bar for new attackers                           |
| Path sanitization              | `sanitizePath()`                                                                      | High - prevents path traversal                                      |
| File type validation           | `isTextFile()`                                                                        | Medium - only text files scanned, but still exploitable             |
| Size limits                    | 50MB total bundle (`MAX_PUBLISH_TOTAL_BYTES`)                                         | High - prevents resource exhaustion                                 |
| Required SKILL.md              | Mandatory readme on publish                                                           | Low security value - informational only                             |
| Static + AST-adjacent scanning | Pattern engine covering exec, exfiltration, credential-harvest, obfuscation, and more | Medium-High - covers many known abuse patterns, still pattern-based |
| LLM-based agentic risk review  | Security-prompt-driven verdict on publish                                             | Medium-High - catches behavior static patterns miss                 |
| VirusTotal scanning            | Wired to skill and package-release publish/rescan flows, gated on operator API key    | High when enabled - static engine detection                         |
| Moderation status              | `moderationStatus` field                                                              | Medium - manual review possible                                     |

### 4.2 Moderation limitations

ClawHub's static scanning inspects skill code content directly (not just slug/metadata/frontmatter), covering dangerous exec calls, dynamic code execution, credential harvesting, exfiltration patterns, obfuscated payloads, and more. Known gaps:

- Pattern-based detection can still be bypassed by sufficiently novel obfuscation.
- LLM-based review and VirusTotal scanning depend on operator-side API keys/config being enabled.
- No runtime execution sandbox isolates a skill from the agent's own privileges once installed.

### 4.3 Badges

Skills and packages carry moderator-assigned badges: `highlighted`, `official`, `deprecated`, `redactionApproved` (skills only). Community reporting (`skillReports`) and audit logging (`auditLogs`) back moderation workflows.

---

## 5. Risk matrix

### 5.1 Likelihood vs impact

| Threat ID     | Likelihood | Impact   | Risk level   | Priority |
| ------------- | ---------- | -------- | ------------ | -------- |
| T-EXEC-001    | High       | Critical | **Critical** | P0       |
| T-PERSIST-001 | High       | Critical | **Critical** | P0       |
| T-EXFIL-003   | Medium     | Critical | **Critical** | P0       |
| T-IMPACT-001  | Medium     | Critical | **High**     | P1       |
| T-EXEC-002    | High       | High     | **High**     | P1       |
| T-EXEC-004    | Medium     | High     | **High**     | P1       |
| T-ACCESS-003  | Medium     | High     | **High**     | P1       |
| T-EXFIL-001   | Medium     | High     | **High**     | P1       |
| T-IMPACT-002  | High       | Medium   | **High**     | P1       |
| T-EVADE-001   | High       | Medium   | **Medium**   | P2       |
| T-ACCESS-001  | Low        | High     | **Medium**   | P2       |
| T-ACCESS-002  | Low        | High     | **Medium**   | P2       |
| T-PERSIST-002 | Low        | High     | **Medium**   | P2       |

### 5.2 Critical path attack chains

**Chain 1: Skill-based data theft**

```text
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(Publish malicious skill) → (Evade moderation) → (Harvest credentials)
```

**Chain 2: Prompt injection to RCE**

```text
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Inject prompt) → (Bypass exec approval) → (Execute commands)
```

**Chain 3: Indirect injection via fetched content**

```text
T-EXEC-002 → T-EXFIL-001 → External exfiltration
(Poison URL content) → (Agent fetches & follows instructions) → (Data sent to attacker)
```

---

## 6. Recommendations summary

### 6.1 Immediate (P0)

| ID    | Recommendation                              | Addresses                  |
| ----- | ------------------------------------------- | -------------------------- |
| R-002 | Implement skill execution sandboxing        | T-PERSIST-001, T-EXFIL-003 |
| R-003 | Add output validation for sensitive actions | T-EXEC-001, T-EXEC-002     |

### 6.2 Short-term (P1)

| ID    | Recommendation                                                        | Addresses    |
| ----- | --------------------------------------------------------------------- | ------------ |
| R-004 | Implement per-sender rate limiting                                    | T-IMPACT-002 |
| R-005 | Add token encryption at rest                                          | T-ACCESS-003 |
| R-006 | Improve exec approval UX and continue expanding command normalization | T-EXEC-004   |
| R-007 | Implement URL allowlisting for `web_fetch`                            | T-EXFIL-001  |

### 6.3 Medium-term (P2)

| ID    | Recommendation                                                                                                                                                        | Addresses     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R-008 | Implemented in core: graded identifier-authentication primitive and audit findings; remaining work is per-channel `verified` adoption and downstream strength mappers | T-ACCESS-002  |
| R-009 | Implement config integrity verification                                                                                                                               | T-PERSIST-003 |
| R-010 | Add update signing and version pinning                                                                                                                                | T-PERSIST-002 |

---

## 7. Appendices

### 7.1 ATLAS technique mapping

| ATLAS ID      | Technique name                 | OpenClaw threats                                                 |
| ------------- | ------------------------------ | ---------------------------------------------------------------- |
| AML.T0006     | Active Scanning                | T-RECON-001, T-RECON-002                                         |
| AML.T0009     | Collection                     | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003                            |
| AML.T0010.001 | Supply Chain: AI Software      | T-PERSIST-001, T-PERSIST-002                                     |
| AML.T0010.002 | Supply Chain: Data             | T-PERSIST-003                                                    |
| AML.T0031     | Erode AI Model Integrity       | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003                         |
| AML.T0040     | AI Model Inference API Access  | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003, T-DISC-001, T-DISC-002 |
| AML.T0043     | Craft Adversarial Data         | T-EXEC-004, T-EVADE-001, T-EVADE-002                             |
| AML.T0051.000 | LLM Prompt Injection: Direct   | T-EXEC-001, T-EXEC-003                                           |
| AML.T0051.001 | LLM Prompt Injection: Indirect | T-EXEC-002                                                       |

### 7.2 Key security files

| Path                                | Purpose                        | Risk level   |
| ----------------------------------- | ------------------------------ | ------------ |
| `src/infra/exec-approvals.ts`       | Command approval logic         | **Critical** |
| `src/gateway/auth.ts`               | Gateway authentication         | **Critical** |
| `src/infra/net/ssrf.ts`             | SSRF protection                | **Critical** |
| `src/security/external-content.ts`  | Prompt injection mitigation    | **Critical** |
| `src/agents/sandbox/tool-policy.ts` | Sandbox tool allow/deny policy | **Critical** |
| `src/routing/resolve-route.ts`      | Session isolation / routing    | **Medium**   |

### 7.3 Glossary

| Term                 | Definition                                                |
| -------------------- | --------------------------------------------------------- |
| **ATLAS**            | MITRE's Adversarial Threat Landscape for AI Systems       |
| **ClawHub**          | OpenClaw's skill marketplace                              |
| **Gateway**          | OpenClaw's message routing and authentication layer       |
| **MCP**              | Model Context Protocol - tool provider interface          |
| **Prompt injection** | Attack where malicious instructions are embedded in input |
| **Skill**            | Downloadable extension for OpenClaw agents                |
| **SSRF**             | Server-Side Request Forgery                               |

---

_This threat model is a living document. Report security issues to `security@openclaw.ai` or see the [Trust page](https://trust.openclaw.ai)._

## Where each section moved

Every heading from the previous single-page version keeps its anchor here, so an existing link such as `/security/THREAT-MODEL-ATLAS#t-exec-002-indirect-prompt-injection` still resolves. Each entry points at the page that now holds the content.

- <a id="3.1-reconnaissance-(aml.ta0002)" /><a id="3-1-reconnaissance-aml-ta0002" />[3.1 Reconnaissance (AML.TA0002)](/security/THREAT-MODEL-ATLAS/reconnaissance)
- <a id="t-recon-001%3A-agent-endpoint-discovery" /><a id="t-recon-001-agent-endpoint-discovery" />[T-RECON-001: Agent endpoint discovery](/security/THREAT-MODEL-ATLAS/reconnaissance#t-recon-001-agent-endpoint-discovery)
- <a id="t-recon-002%3A-channel-integration-probing" /><a id="t-recon-002-channel-integration-probing" />[T-RECON-002: Channel integration probing](/security/THREAT-MODEL-ATLAS/reconnaissance#t-recon-002-channel-integration-probing)
- <a id="3.2-initial-access-(aml.ta0004)" /><a id="3-2-initial-access-aml-ta0004" />[3.2 Initial access (AML.TA0004)](/security/THREAT-MODEL-ATLAS/initial-access)
- <a id="t-access-001%3A-pairing-code-interception" /><a id="t-access-001-pairing-code-interception" />[T-ACCESS-001: Pairing code interception](/security/THREAT-MODEL-ATLAS/initial-access#t-access-001-pairing-code-interception)
- <a id="t-access-002%3A-allowfrom-spoofing" /><a id="t-access-002-allowfrom-spoofing" />[T-ACCESS-002: AllowFrom spoofing](/security/THREAT-MODEL-ATLAS/initial-access#t-access-002-allowfrom-spoofing)
- <a id="t-access-003%3A-token-theft" /><a id="t-access-003-token-theft" />[T-ACCESS-003: Token theft](/security/THREAT-MODEL-ATLAS/initial-access#t-access-003-token-theft)
- <a id="3.3-execution-(aml.ta0005)" /><a id="3-3-execution-aml-ta0005" />[3.3 Execution (AML.TA0005)](/security/THREAT-MODEL-ATLAS/execution)
- <a id="t-exec-001%3A-direct-prompt-injection" /><a id="t-exec-001-direct-prompt-injection" />[T-EXEC-001: Direct prompt injection](/security/THREAT-MODEL-ATLAS/execution#t-exec-001-direct-prompt-injection)
- <a id="t-exec-002%3A-indirect-prompt-injection" /><a id="t-exec-002-indirect-prompt-injection" />[T-EXEC-002: Indirect prompt injection](/security/THREAT-MODEL-ATLAS/execution#t-exec-002-indirect-prompt-injection)
- <a id="t-exec-003%3A-tool-argument-injection" /><a id="t-exec-003-tool-argument-injection" />[T-EXEC-003: Tool argument injection](/security/THREAT-MODEL-ATLAS/execution#t-exec-003-tool-argument-injection)
- <a id="t-exec-004%3A-exec-approval-bypass" /><a id="t-exec-004-exec-approval-bypass" />[T-EXEC-004: Exec approval bypass](/security/THREAT-MODEL-ATLAS/execution#t-exec-004-exec-approval-bypass)
- <a id="3.4-persistence-(aml.ta0006)" /><a id="3-4-persistence-aml-ta0006" />[3.4 Persistence (AML.TA0006)](/security/THREAT-MODEL-ATLAS/persistence)
- <a id="t-persist-001%3A-malicious-skill-installation" /><a id="t-persist-001-malicious-skill-installation" />[T-PERSIST-001: Malicious skill installation](/security/THREAT-MODEL-ATLAS/persistence#t-persist-001-malicious-skill-installation)
- <a id="t-persist-002%3A-skill-update-poisoning" /><a id="t-persist-002-skill-update-poisoning" />[T-PERSIST-002: Skill update poisoning](/security/THREAT-MODEL-ATLAS/persistence#t-persist-002-skill-update-poisoning)
- <a id="t-persist-003%3A-agent-configuration-tampering" /><a id="t-persist-003-agent-configuration-tampering" />[T-PERSIST-003: Agent configuration tampering](/security/THREAT-MODEL-ATLAS/persistence#t-persist-003-agent-configuration-tampering)
- <a id="3.5-defense-evasion-(aml.ta0007)" /><a id="3-5-defense-evasion-aml-ta0007" />[3.5 Defense evasion (AML.TA0007)](/security/THREAT-MODEL-ATLAS/defense-evasion)
- <a id="t-evade-001%3A-moderation-pattern-bypass" /><a id="t-evade-001-moderation-pattern-bypass" />[T-EVADE-001: Moderation pattern bypass](/security/THREAT-MODEL-ATLAS/defense-evasion#t-evade-001-moderation-pattern-bypass)
- <a id="t-evade-002%3A-content-wrapper-escape" /><a id="t-evade-002-content-wrapper-escape" />[T-EVADE-002: Content wrapper escape](/security/THREAT-MODEL-ATLAS/defense-evasion#t-evade-002-content-wrapper-escape)
- <a id="3.6-discovery-(aml.ta0008)" /><a id="3-6-discovery-aml-ta0008" />[3.6 Discovery (AML.TA0008)](/security/THREAT-MODEL-ATLAS/discovery)
- <a id="t-disc-001%3A-tool-enumeration" /><a id="t-disc-001-tool-enumeration" />[T-DISC-001: Tool enumeration](/security/THREAT-MODEL-ATLAS/discovery#t-disc-001-tool-enumeration)
- <a id="t-disc-002%3A-session-data-extraction" /><a id="t-disc-002-session-data-extraction" />[T-DISC-002: Session data extraction](/security/THREAT-MODEL-ATLAS/discovery#t-disc-002-session-data-extraction)
- <a id="3.7-collection-and-exfiltration-(aml.ta0009%2C-aml.ta0010)" /><a id="3-7-collection-and-exfiltration-aml-ta0009-aml-ta0010" />[3.7 Collection and exfiltration (AML.TA0009, AML.TA0010)](/security/THREAT-MODEL-ATLAS/collection-and-exfiltration)
- <a id="t-exfil-001%3A-data-theft-via-web_fetch" /><a id="t-exfil-001-data-theft-via-web_fetch" />[T-EXFIL-001: Data theft via web_fetch](/security/THREAT-MODEL-ATLAS/collection-and-exfiltration#t-exfil-001-data-theft-via-web_fetch)
- <a id="t-exfil-002%3A-unauthorized-message-sending" /><a id="t-exfil-002-unauthorized-message-sending" />[T-EXFIL-002: Unauthorized message sending](/security/THREAT-MODEL-ATLAS/collection-and-exfiltration#t-exfil-002-unauthorized-message-sending)
- <a id="t-exfil-003%3A-credential-harvesting" /><a id="t-exfil-003-credential-harvesting" />[T-EXFIL-003: Credential harvesting](/security/THREAT-MODEL-ATLAS/collection-and-exfiltration#t-exfil-003-credential-harvesting)
- <a id="3.8-impact-(aml.ta0011)" /><a id="3-8-impact-aml-ta0011" />[3.8 Impact (AML.TA0011)](/security/THREAT-MODEL-ATLAS/impact)
- <a id="t-impact-001%3A-unauthorized-command-execution" /><a id="t-impact-001-unauthorized-command-execution" />[T-IMPACT-001: Unauthorized command execution](/security/THREAT-MODEL-ATLAS/impact#t-impact-001-unauthorized-command-execution)
- <a id="t-impact-002%3A-resource-exhaustion-(dos)" /><a id="t-impact-002-resource-exhaustion-dos" />[T-IMPACT-002: Resource exhaustion (DoS)](/security/THREAT-MODEL-ATLAS/impact#t-impact-002-resource-exhaustion-dos)
- <a id="t-impact-003%3A-reputation-damage" /><a id="t-impact-003-reputation-damage" />[T-IMPACT-003: Reputation damage](/security/THREAT-MODEL-ATLAS/impact#t-impact-003-reputation-damage)

## Related

- [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL)
- [Incident response](/security/incident-response)
- [Network proxy](/security/network-proxy)
- [Formal verification](/security/formal-verification)
