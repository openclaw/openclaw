# MeshGuard

**The Missing Governance Layer for Autonomous AI Agents**

---

## One-Liner

> MeshGuard is the governance control plane for AI agent ecosystems — providing identity, policy, and audit for agent-to-agent interactions.

---

## The Problem

As AI evolves from copilots to autonomous agents to agent meshes, a critical governance gap emerges:

- **No identity verification** for agent-to-agent calls
- **Zero policy enforcement** at delegation boundaries
- **Incomplete audit trails** across agent chains
- **Compliance risk** for regulated industries (GDPR, SOC 2, HIPAA)

When Agent A delegates to Agent B, traditional identity controls break down. Organizations are operating blind.

**Market Reality:**
- Gartner: 40% of enterprises will deploy agent mesh architectures by 2026
- 73% of CIOs cite governance as their top AI concern
- $180K average annual enterprise spend on AI security

---

## The Solution

MeshGuard sits between agents as a governance control plane, intercepting every delegation request to enforce:

| Capability | What It Does |
|------------|--------------|
| **🔐 Identity** | Verifiable agent credentials with trust tiers (anonymous → privileged) |
| **📋 Policy** | Declarative YAML policies with real-time enforcement |
| **📝 Audit** | Complete trail of every agent action for compliance |
| **🔗 Delegation** | Permission ceilings prevent privilege escalation |
| **⚡ Real-time** | Sub-millisecond policy decisions at scale |
| **🔌 Universal** | Works with LangChain, CrewAI, AutoGPT, custom agents |

---

## How It Works

```
Agent A → [MeshGuard] → Agent B → [MeshGuard] → Tool
              │                        │
         Identity Check           Policy Check
         Policy Check             Audit Logged
         Audit Logged
```

Every agent action passes through MeshGuard. Policies are enforced in real-time. Everything is logged for compliance.

---

## Traction

| Metric | Value |
|--------|-------|
| Learning Center | 16 deep-dive articles |
| Demo Applications | 3 production-ready examples |
| Documentation | Complete SDK + API reference |
| Self-Service | Live signup at meshguard.app |
| Python SDK | Published on PyPI |

---

## Business Model

**Pricing Tiers:**

| Tier | Price | Agents | Requests/mo |
|------|-------|--------|-------------|
| Free | $0 | 5 | 10K |
| Starter | $2,000/mo | 50 | 100K |
| Professional | $10,000/mo | 500 | 1M |
| Enterprise | Custom | Unlimited | Unlimited |

**Go-to-Market:**
- Product-led growth via free tier
- Content marketing (SEO-optimized learning center)
- Enterprise sales for $100K+ deals
- Target: AI-forward companies in regulated industries

---

## Competitive Landscape

| Solution | Focus | MeshGuard Advantage |
|----------|-------|---------------------|
| Descope | Agent identity (auth) | We do governance (authz) |
| OPA | Infrastructure policy | We're agent-native |
| LangChain Guardrails | Content filtering | We do action control |
| Constitutional AI | Training-time alignment | We're runtime enforcement |

**MeshGuard is the only purpose-built governance layer for multi-agent systems.**

---

## The Ask

**Raising:** Pre-seed round  
**Use of Funds:** Engineering (SDK expansion), GTM (content + partnerships), first enterprise customers

---

## Links

- **Website:** https://meshguard.app
- **Learning Center:** https://learn.meshguard.app
- **Documentation:** https://docs.meshguard.app
- **Demo:** Chat with Scout at meshguard.app

---

## Contact

**David Hurley**  
Founder  
david@meshguard.app

---

*Confidential — For Investment Purposes Only*  
*© 2026 MeshGuard*
