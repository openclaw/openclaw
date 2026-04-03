# ATR Detection Rule Mapping for OpenClaw Security Threats

[Agent Threat Rules (ATR)](https://github.com/Agent-Threat-Rule/agent-threat-rules) is an open-source set of detection rules for AI agent security threats. This document maps ATR rules to OpenClaw's documented threat categories, providing practitioners with executable detection for each threat.

**ATR version:** v0.4.0+ (76 rules) | **License:** MIT | **Engines:** TypeScript + Python | **OWASP Agentic Top 10:** 10/10 coverage

## Why This Mapping Exists

OpenClaw's security documentation describes **what** the threats are and how to harden against them. ATR provides **how** to detect active exploitation of those threats at runtime — 76 open-source regex rules with test cases, executing in <5ms per scan.

This gives OpenClaw operators a path from "understand the threat" to "detect it in production":

1. Read the threat description in OpenClaw's security docs
2. Find the corresponding ATR rules in this mapping
3. Deploy via ATR's TypeScript/Python engine, MCP server, or convert to Splunk/Elastic queries

## Coverage Summary

| OpenClaw Threat Category                    | ATR Rules | Coverage |
| ------------------------------------------- | --------- | -------- |
| Prompt Injection & Goal Hijacking           | 18 rules  | STRONG   |
| Tool Interaction Manipulation               | 9 rules   | STRONG   |
| Credential & Secret Exposure                | 8 rules   | STRONG   |
| Skill Supply Chain Attacks                  | 13 rules  | STRONG   |
| Cross-Agent & Multi-Agent Exploitation      | 6 rules   | STRONG   |
| Privilege Escalation & Authorization Bypass | 6 rules   | STRONG   |
| Resource Exhaustion & Runaway Loops         | 4 rules   | MODERATE |
| Data Exfiltration & Privacy Leakage         | 5 rules   | MODERATE |
| Session & Memory Manipulation               | 4 rules   | MODERATE |

**Total: 48 unique rules referenced across 9 threat categories (from ATR's 76-rule library)**

---

## Detailed Mappings

### 1. Prompt Injection & Goal Hijacking

OpenClaw's trust model assumes a single trusted operator, but **any allowed sender can steer tool calls** within the agent's policy. Prompt injection from one sender can cause actions affecting shared state. OpenClaw's security docs note: "prompt/content injection from one sender can cause actions that affect shared state, devices, or outputs."

| ATR Rule     | Title                                          | Severity | Relevance to OpenClaw                                 |
| ------------ | ---------------------------------------------- | -------- | ----------------------------------------------------- |
| ATR-2026-001 | Direct Prompt Injection via User Input         | HIGH     | Messages from any allowed sender in DM/Slack/Discord  |
| ATR-2026-002 | Indirect Prompt Injection via External Content | HIGH     | External content fetched by browser/network tools     |
| ATR-2026-003 | Jailbreak Attempt Detection                    | HIGH     | Attempts to bypass agent safety mechanisms            |
| ATR-2026-004 | System Prompt Override Attempt                 | CRITICAL | Override agent personality/instructions via messaging |
| ATR-2026-005 | Multi-Turn Prompt Injection                    | MEDIUM   | Gradual manipulation across conversation turns        |
| ATR-2026-032 | Agent Goal Hijacking Detection                 | HIGH     | Redirecting agent from original task                  |
| ATR-2026-081 | Semantic Multi-Turn Injection                  | HIGH     | Sophisticated multi-turn attack patterns              |
| ATR-2026-084 | Structured Data Injection                      | MEDIUM   | Injection via JSON/XML/structured inputs              |
| ATR-2026-086 | Visual Spoofing                                | MEDIUM   | Unicode/homoglyph attacks in messages                 |
| ATR-2026-091 | Nested Payload Injection                       | HIGH     | Payloads nested in tool descriptions/responses        |
| ATR-2026-093 | Gradual Escalation Pattern                     | HIGH     | Slowly escalating privileges across turns             |
| ATR-2026-097 | CJK Injection Patterns                         | MEDIUM   | Multi-language injection patterns                     |
| ATR-2026-100 | Consent Bypass via Hidden Instructions         | HIGH     | Hidden instructions in tool descriptions              |
| ATR-2026-101 | Trust Escalation Override                      | HIGH     | Overriding trust boundaries                           |
| ATR-2026-103 | Hidden Safety Bypass Instructions              | CRITICAL | "NOTE TO AI:" patterns bypassing safety               |
| ATR-2026-104 | Persona Hijacking via Response Manipulation    | HIGH     | Hijacking agent identity                              |
| ATR-2026-105 | Silent Action Concealment                      | HIGH     | Hiding malicious actions from user                    |
| ATR-2026-107 | Delayed Execution Bypass                       | HIGH     | Time-delayed payload activation                       |

### 2. Tool Interaction Manipulation

OpenClaw agents use tools (exec, browser, network, file tools) with delegated authority. OpenClaw docs warn: "any allowed sender can induce tool calls within the agent's policy." These rules detect manipulation of tool inputs and outputs.

| ATR Rule     | Title                                  | Severity | Relevance to OpenClaw                                |
| ------------ | -------------------------------------- | -------- | ---------------------------------------------------- |
| ATR-2026-010 | Malicious Content in MCP Tool Response | CRITICAL | Poisoned tool responses redirecting agent behavior   |
| ATR-2026-011 | Instruction Injection via Tool Output  | HIGH     | Hidden instructions in tool return values            |
| ATR-2026-012 | Unauthorized Tool Call Detection       | HIGH     | Parameter injection, path traversal via tools        |
| ATR-2026-013 | SSRF via Agent Tool Calls              | CRITICAL | Using agent tools to reach internal services         |
| ATR-2026-060 | Dangerous Shell Commands               | CRITICAL | rm -rf, curl\|bash, reverse shells via exec tools    |
| ATR-2026-061 | File System Manipulation               | HIGH     | Unauthorized file read/write/delete operations       |
| ATR-2026-062 | Network Exfiltration Patterns          | CRITICAL | Data sent to external endpoints via tools            |
| ATR-2026-063 | Sensitive Path Access                  | HIGH     | Access to ~/.ssh, ~/.aws, .env, /etc/passwd          |
| ATR-2026-106 | Schema-Description Contradiction       | MEDIUM   | Tool schema says one thing, description says another |

### 3. Credential & Secret Exposure

OpenClaw agents operate under user-assigned credentials. These rules detect credential theft, secret leakage, and API key exposure.

| ATR Rule     | Title                                          | Severity | Relevance to OpenClaw                                |
| ------------ | ---------------------------------------------- | -------- | ---------------------------------------------------- |
| ATR-2026-021 | Credential and Secret Exposure in Agent Output | CRITICAL | API keys, tokens leaked in agent responses           |
| ATR-2026-020 | System Prompt Leakage                          | HIGH     | Agent revealing its internal instructions            |
| ATR-2026-113 | Credential Theft via Agent Manipulation        | CRITICAL | Tricking agent into reading/exfiltrating credentials |
| ATR-2026-114 | OAuth Token Abuse                              | HIGH     | Exploiting OAuth flows through agent                 |
| ATR-2026-115 | Bulk Environment Variable Harvesting           | CRITICAL | Reading .env files + exfiltrating contents           |
| ATR-2026-070 | PII Exposure                                   | HIGH     | Agent leaking personal data                          |
| ATR-2026-071 | Sensitive Business Data Exposure               | HIGH     | Proprietary data in agent outputs                    |
| ATR-2026-072 | Training Data Extraction                       | MEDIUM   | Extracting training data from models                 |

### 4. Skill Supply Chain Attacks

ClawHub hosts 13,729+ skills with 1,184+ known malicious entries. OpenClaw partnered with VirusTotal for malware scanning, but prompt injection and social engineering in SKILL.md files are not covered by VirusTotal.

| ATR Rule     | Title                                  | Severity | Relevance to OpenClaw                           |
| ------------ | -------------------------------------- | -------- | ----------------------------------------------- |
| ATR-2026-100 | Consent Bypass via Hidden Instructions | HIGH     | Hidden directives in SKILL.md/tool descriptions |
| ATR-2026-101 | Trust Escalation Override              | HIGH     | Skills claiming elevated trust                  |
| ATR-2026-103 | Hidden Safety Bypass Instructions      | CRITICAL | "NOTE TO AI" patterns in skill content          |
| ATR-2026-105 | Silent Action Concealment              | HIGH     | Skills hiding their true actions                |
| ATR-2026-106 | Schema-Description Contradiction       | MEDIUM   | Tool schema ≠ description (deception)           |
| ATR-2026-120 | SKILL.md Prompt Injection              | CRITICAL | Malicious instructions embedded in skill files  |
| ATR-2026-121 | Malicious Code in Skills               | HIGH     | Base64 payloads, credential theft in skill code |
| ATR-2026-122 | Weaponized Skill Instructions          | HIGH     | Skills instructing agent to run exploits        |
| ATR-2026-123 | Over-Privileged Skill Permissions      | MEDIUM   | Skills requesting excessive permissions         |
| ATR-2026-124 | Skill Name Squatting                   | MEDIUM   | Typosquatting popular skill names               |
| ATR-2026-060 | Dangerous Shell Commands               | CRITICAL | curl\|bash, wget\|sh in skill prerequisites     |
| ATR-2026-061 | File System Manipulation               | HIGH     | Skills accessing unauthorized paths             |
| ATR-2026-062 | Network Exfiltration Patterns          | CRITICAL | Skills sending data to external C2 servers      |

### 5. Cross-Agent & Multi-Agent Exploitation

OpenClaw supports multi-agent orchestration. These rules detect attacks that exploit trust between agents.

| ATR Rule     | Title                                | Severity | Relevance to OpenClaw                          |
| ------------ | ------------------------------------ | -------- | ---------------------------------------------- |
| ATR-2026-030 | Cross-Agent Attack Detection         | CRITICAL | Agent impersonation and delegation abuse       |
| ATR-2026-032 | Agent Goal Hijacking                 | HIGH     | Redirecting agent objectives via other agents  |
| ATR-2026-040 | Privilege Escalation                 | CRITICAL | Escalating permissions across agent boundaries |
| ATR-2026-041 | Agent Scope Creep                    | MEDIUM   | Gradual authority expansion                    |
| ATR-2026-052 | Cascading Failure in Agent Pipelines | HIGH     | Error propagation across agent chains          |
| ATR-2026-104 | Persona Hijacking                    | HIGH     | One agent manipulating another's identity      |

### 6. Privilege Escalation & Authorization Bypass

OpenClaw's exec approvals are "guardrails for operator intent, not hostile multi-tenant isolation." These rules detect attempts to bypass those guardrails.

| ATR Rule     | Title                  | Severity | Relevance to OpenClaw                           |
| ------------ | ---------------------- | -------- | ----------------------------------------------- |
| ATR-2026-040 | Privilege Escalation   | CRITICAL | Accessing admin functions without authorization |
| ATR-2026-041 | Agent Scope Creep      | MEDIUM   | Gradually expanding permissions                 |
| ATR-2026-004 | System Prompt Override | CRITICAL | Overriding operator-set instructions            |
| ATR-2026-012 | Unauthorized Tool Call | HIGH     | Calling tools outside approved scope            |
| ATR-2026-113 | Credential Theft       | CRITICAL | Stealing credentials to escalate access         |
| ATR-2026-114 | OAuth Token Abuse      | HIGH     | Exploiting OAuth for unauthorized access        |

### 7. Resource Exhaustion & Runaway Loops

| ATR Rule     | Title                        | Severity | Relevance to OpenClaw                    |
| ------------ | ---------------------------- | -------- | ---------------------------------------- |
| ATR-2026-050 | Runaway Agent Loop Detection | HIGH     | Infinite retry/action loops              |
| ATR-2026-051 | Agent Resource Exhaustion    | HIGH     | Bulk operations, unbounded queries       |
| ATR-2026-052 | Cascading Failure Detection  | HIGH     | Error propagation in agent pipelines     |
| ATR-2026-090 | Rate Limit Evasion           | MEDIUM   | Bypassing rate limits through techniques |

### 8. Data Exfiltration & Privacy Leakage

OpenClaw docs warn: "if one shared agent has sensitive credentials/files, any allowed sender can potentially drive exfiltration via tool usage."

| ATR Rule     | Title                                | Severity | Relevance to OpenClaw           |
| ------------ | ------------------------------------ | -------- | ------------------------------- |
| ATR-2026-062 | Network Exfiltration Patterns        | CRITICAL | Data sent to external endpoints |
| ATR-2026-063 | Sensitive Path Access                | HIGH     | Reading ~/.ssh, ~/.aws, .env    |
| ATR-2026-070 | PII Exposure                         | HIGH     | Personal data in agent outputs  |
| ATR-2026-071 | Sensitive Business Data Exposure     | HIGH     | Proprietary data leakage        |
| ATR-2026-115 | Bulk Environment Variable Harvesting | CRITICAL | Mass .env file reading          |

### 9. Session & Memory Manipulation

OpenClaw's session isolation "degrades over time" in async workloads. These rules detect manipulation of agent memory and context.

| ATR Rule     | Title                      | Severity | Relevance to OpenClaw                    |
| ------------ | -------------------------- | -------- | ---------------------------------------- |
| ATR-2026-080 | Encoding Evasion           | MEDIUM   | Bypassing detection via encoding tricks  |
| ATR-2026-084 | Structured Data Injection  | MEDIUM   | Poisoning structured context/memory      |
| ATR-2026-091 | Nested Payload Injection   | HIGH     | Payloads hidden in memory/context data   |
| ATR-2026-093 | Gradual Escalation Pattern | HIGH     | Slowly poisoning context across sessions |

---

## Quick Start

### Scan a skill before installation

```bash
npx @panguard-ai/panguard audit skill <skill-name>
```

### Run ATR engine programmatically

```typescript
import { ATREngine } from "agent-threat-rules";

const engine = new ATREngine();
await engine.loadRules();
const matches = engine.evaluate({
  type: "tool_response",
  timestamp: new Date().toISOString(),
  content: skillContent,
});
// matches: Array<{ rule, matchedConditions, matchedPatterns, confidence, timestamp }>
```

### ATR as MCP server (self-audit)

ATR ships as an MCP server, enabling AI agents to scan other skills and self-audit their own behavior.

```json
{
  "mcpServers": {
    "atr": {
      "command": "atr",
      "args": ["mcp"]
    }
  }
}
```

---

## Relationship to OpenClaw Existing Security

| Layer                   | Tool                      | What it does                                                                            |
| ----------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| **Malware detection**   | VirusTotal (built-in)     | Binary malware signatures                                                               |
| **Configuration audit** | `openclaw security audit` | Config footguns, permissions                                                            |
| **Threat detection**    | **ATR (this mapping)**    | Prompt injection, credential theft, supply chain attacks in skill content and agent I/O |
| **Runtime monitoring**  | DefenseClaw, ClawSecure   | Real-time behavioral analysis                                                           |

ATR complements VirusTotal (which doesn't detect prompt injection) and `openclaw security audit` (which doesn't scan skill content). Together they provide defense in depth.

---

## References

- [ATR GitHub Repository](https://github.com/Agent-Threat-Rule/agent-threat-rules)
- [PanGuard CLI](https://github.com/panguard-ai/panguard-ai) — Scanner using ATR rules, supports OpenClaw
- [ATR Paper](https://doi.org/10.5281/zenodo.19178002) — Academic paper on Threat Crystallization methodology
- [PINT Benchmark Results](https://github.com/Agent-Threat-Rule/agent-threat-rules/tree/main/data/pint-benchmark) — 62.7% recall, 99.7% precision on 850 adversarial samples
- [OWASP Agentic AI Top 10 Mapping](https://github.com/precize/Agentic-AI-Top10-Vulnerability/blob/main/ATR-DETECTION-MAPPING.md) — ATR mapping merged into OWASP repo
- [OpenClaw Security Documentation](/gateway/security)
