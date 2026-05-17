# agent-shield

Runtime security for OpenClaw multi-agent setups.

Scans every agent-to-agent message, tool call, and tool result for prompt injection, identity spoofing, context poisoning, delegation loops, confidence amplification, privilege escalation, data exfiltration, and secret leaks. When something fires, the agent gets paused, downstream agents get a warning annotation, active work is redistributed to healthy agents, partial output is sent to an independent agent for verification, and after a few failed recovery attempts the whole thing is escalated to a human with a concrete diagnosis.

## Rules

18 rules, stable IDs so audit logs stay readable across versions:

| ID | Rule | Category | Severity |
|----|------|----------|----------|
| T01 | Prompt Override Injection | prompt_injection | critical |
| T02 | Encoded Instruction Injection | prompt_injection | high |
| T03 | Agent Identity Spoofing | identity_spoofing | high |
| T04 | Delegation Loop Detection | delegation_loop | high |
| T05 | Confidence Amplification | confidence_amplification | medium |
| T06 | Context Window Poisoning | context_poisoning | high |
| T07 | Privilege Escalation via Tool Manipulation | privilege_escalation | critical |
| T08 | Data Exfiltration Attempt | data_exfiltration | critical |
| T09 | Tool Schema Injection | tool_abuse | high |
| T10 | Secret Leak in Output | secret_leak | high |
| T11 | Recursive Self-Modification | privilege_escalation | critical |
| T12 | Instruction Boundary Confusion | prompt_injection | high |
| T13 | Jailbreak Template Detection | prompt_injection | critical |
| T14 | Delegation Depth Exceeded | delegation_loop | high |
| T15 | UI Spoofing via Markup | context_poisoning | medium |
| T16 | Memory Poisoning | context_poisoning | high |
| T17 | MCP Server Abuse | tool_abuse | high |
| T18 | Multi-Turn Coordinated Manipulation | context_poisoning | medium |

## Recovery flow

1. Pause the compromised agent
2. Annotate downstream agents with an elevated-scrutiny warning
3. Redistribute active work to healthy agents (priority-weighted round-robin)
4. Generate verification claims for partial output, assigned to an independent agent
5. Escalate to human review with a structured artifact (diagnosis, context, fix steps) after `maxRecoveryAttempts`

## Secret redaction

17 credential patterns (AWS, OpenAI, Anthropic, GitHub, Slack, Stripe, JWTs, private keys, DB URLs, etc.) are stripped from outbound messages before they reach any channel.

## MCP env filtering

When OpenClaw spawns an MCP subprocess, only `PATH`, `HOME`, `XDG_*`, `LANG`, `LC_*` (and anything you explicitly allow) get passed through. Everything else - especially API keys - is dropped.

## Config

```json5
{
  plugins: {
    entries: {
      "agent-shield": {
        enabled: true,
        config: {
          mode: "enforce",          // "monitor" or "enforce"
          maxDelegationDepth: 3,
          maxRecoveryAttempts: 3,
          redactSecrets: true,
          filterMcpEnv: true,
          allowedEnvVars: [],       // extra env vars passed to MCP subprocesses
          threatLog: "both"         // "file", "memory", or "both"
        }
      }
    }
  }
}
```

## CLI

```bash
openclaw agent-shield status            # stats and overview
openclaw agent-shield agents            # agent health states
openclaw agent-shield rules             # list all threat rules
openclaw agent-shield resume <agentId>  # resume a paused agent
openclaw agent-shield reset             # clear all shield state
```

## Agent tools

```
agent_shield_status query=stats    # aggregate stats
agent_shield_status query=agents   # agent health states
agent_shield_status query=recent   # last 10 threat events
agent_shield_status query=rules    # active rules

agent_shield_resume agentId=<id>   # approval-gated resume
```

## How it hooks in

This is a hook-only plugin (no provider, no channel). Two interception points:

- `before_prompt_build` - scans tool results and delegated agent messages before they enter the prompt
- `message_sending` - redacts secrets from outbound messages before channel delivery

Scanning is synchronous and runs in single-digit milliseconds. In `enforce` mode, critical threats are blocked; in `monitor` mode everything is logged but allowed through.

## License

MIT
