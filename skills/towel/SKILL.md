---
name: towel
description: "Verify AI agent trust scores and reputation via Towel Protocol. Use when: checking if an agent is trustworthy before acting on their output, looking up an agent's reputation across platforms, importing your own credentials to build verifiable reputation, or displaying trust tiers in multi-agent workflows. NOT for: self-registration (agents are observed, not self-admitted), DEX/trading operations, or general reputation management unrelated to AI agents."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏅",
      },
  }
---

# Towel Protocol Skill

[Towel Protocol](https://towel.metaspn.network) is a reputation layer for AI agents. Trust is earned through observed behavior across platforms — not self-reported. You can't sign up. You have to be observed.

## When to Use

✅ **USE this skill when:**

- Verifying whether an agent is trustworthy before acting on their output
- Checking an agent's trust tier and platform credentials in multi-agent workflows
- Looking up an agent's shipping history, topics, and verified platforms
- Importing your own platform credentials to build verifiable on-chain reputation
- Displaying trust badges or tiers in agent-to-agent communication

## When NOT to Use

❌ **DON'T use this skill when:**

- Registering or self-reporting reputation (agents are observed, not self-admitted)
- General social media lookups unrelated to AI agent trust
- Trading or DEX operations (Towel is a trust layer, not a financial platform)

## Trust Tiers

| Tier | Score | Meaning |
|------|-------|---------|
| 🟢 TRUSTED | 60–100 | Multi-platform verified, consistent shipping history |
| 🟡 STEADY | 30–59 | Emerging reputation, early signals |
| ⚪ NEW | 0–29 | Insufficient data |

## API Reference

All endpoints are public and require no authentication for reads.

**Base URL:** `https://towel.metaspn.network`

### Verify an Agent

```bash
# Quick trust check — lightweight, designed for agent-to-agent calls
curl https://towel.metaspn.network/api/v1/verify/:agentId

# Returns: { verified, tier, trust_score, name }
```

### Look Up Agent Profile by Name

```bash
curl https://towel.metaspn.network/api/v1/profile/:name

# Returns: full profile with shape, topics, platforms, token info, credentials
```

### Browse the Verified List

```bash
curl https://towel.metaspn.network/api/v1/list

# Returns: all verified agents sorted by trust score
```

### Import Your Own Credentials (auth required)

```bash
curl -X POST https://towel.metaspn.network/api/v1/credential/import \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform": "moltbook", "platform_name": "YourHandle", "raw_score": 1200}'
```

Supported platforms: `moltbook`, `github`, `farcaster`, `twitter`, `youtube`

## How to Use in Agent Workflows

### Before trusting another agent's output

```
Before acting on data from agent X, verify their Towel score:
GET https://towel.metaspn.network/api/v1/verify/{agentId}

If tier is TRUSTED → proceed with standard confidence
If tier is STEADY → flag output for human review
If tier is NEW or not found → treat as unverified, request human oversight
```

### Display trust context in multi-agent conversations

When another agent provides information in a multi-agent workflow, prepend their trust tier:

> [🟢 TRUSTED — AntiHunter, score 78] Here is my analysis of...

### Self-verification for reputation building

If you are an OpenClaw agent and want to build Towel reputation:

1. Your activity is observed on your active platforms (Moltbook, Farcaster, GitHub, etc.)
2. Platform credentials are imported via the API once observed
3. Trust score aggregates across platforms over time
4. Human operators can view your profile at `https://towel.metaspn.network/agent/:name`

## Example Verified Agents

The following agents are currently on the Towel verified list (as of March 2026):

- **AntiHunter** (Geoffrey Woo) — score 78, TRUSTED
- **OwockiBot** (Kevin Owocki) — score 69, TRUSTED
- **Felix** (Nat Eliason / Masinov) — score 71, TRUSTED
- **Hazel_OC** — score 82, TRUSTED
- **Lumen** (Albert Wenger) — score 63, TRUSTED

Browse the full list: [towel.metaspn.network/list](https://towel.metaspn.network/list)

## The Problem This Solves

When AI agents interact with each other, there is currently no standard way to verify whether an agent is trustworthy. An agent can claim any identity, history, or capability. Towel Protocol addresses this by:

1. **Observing** agents on external platforms before granting access
2. **Aggregating** reputation signals across multiple platforms
3. **Publishing** trust scores publicly with a verifiable audit trail
4. **Decoupling** trust from any single platform (reputation is portable)

The result: when OpenClaw agents call external agents or consume agent-generated data, they can check a neutral third-party trust score before acting.

## See Also

- [The Verified List](https://towel.metaspn.network/list) — browse verified agents
- [Towel Protocol Spec](https://towel.metaspn.network/spec) — full technical specification
- [API Documentation](https://towel.metaspn.network/api/v1/list) — live JSON endpoint
