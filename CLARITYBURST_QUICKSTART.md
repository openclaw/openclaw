# ClarityBurst in OpenClaw - Quick Start

ClarityBurst is an integrated **decision-gating system** that controls operation execution across 12 capability stages in OpenClaw.

## What It Does

```
OpenClaw Agent → [ClarityBurst Gate] → Allow/Block/Confirm → Execute or Deny
```

ClarityBurst ensures all side-effectful operations (shell commands, network requests, file I/O, sub-agent spawning, etc.) pass through deterministic routing and confidence checks before execution.

## Key Features

✅ **Fail-Closed by Default** — Blocks unless confident  
✅ **12 Gating Stages** — SHELL_EXEC, NETWORK_IO, FILE_SYSTEM_OPS, TOOL_DISPATCH_GATE, etc.  
✅ **Threshold Logic** — Confidence + dominance checks before allowing execution  
✅ **Confirmation Workflow** — HIGH/CRITICAL operations require user approval  
✅ **Enterprise-Ready** — Deterministic, auditable, recoverable  
✅ **Separate Service** — Runs as independent HTTP service (not embedded)

## For OpenClaw Developers & Operators

### I'm integrating ClarityBurst into OpenClaw

👉 **Read:** [`clarityburst-docs/architecture/OPENCLAW_INTEGRATION.md`](clarityburst-docs/architecture/OPENCLAW_INTEGRATION.md)

This explains:
- How the 12 gating stages work
- The API contract (request/response format)
- Configuration and startup
- Example payloads for each stage
- Threshold logic
- Fail-closed guarantees
- Testing strategy

**Time to read:** 15-20 minutes  
**What you'll know:** Complete integration picture

---

### I need to deploy ClarityBurst to production

👉 **Read:** [`clarityburst-docs/operations/QUICK_START.md`](clarityburst-docs/operations/QUICK_START.md)  
👉 **Then:** [`clarityburst-docs/operations/PRODUCTION_ROADMAP.md`](clarityburst-docs/operations/PRODUCTION_ROADMAP.md)

---

### I need to understand the security model

👉 **Read:** [`clarityburst-docs/security/ENTERPRISE_SECURITY_SUMMARY.md`](clarityburst-docs/security/ENTERPRISE_SECURITY_SUMMARY.md)

---

### I'm reviewing or auditing ClarityBurst

👉 **Read:** [`clarityburst-docs/architecture/CONTROL_PLANE_ANALOGY.md`](clarityburst-docs/architecture/CONTROL_PLANE_ANALOGY.md)  
👉 **Then:** [`clarityburst-docs/validation/SECURITY_AUDIT_REPORT.md`](clarityburst-docs/validation/SECURITY_AUDIT_REPORT.md)

---

## Architecture at a Glance

### The 12 Gating Stages

| Stage | Purpose | Example |
|-------|---------|---------|
| **TOOL_DISPATCH_GATE** | Which tool to invoke | Route to web_search, calculator, email |
| **SHELL_EXEC** | Command execution | Allow `npm test`, block `rm -rf /` |
| **FILE_SYSTEM_OPS** | File operations | Allow read, require confirmation for write |
| **NETWORK_IO** | Network requests | Allow HTTPS GET, block non-HTTPS |
| **MEMORY_MODIFY** | Context updates | Allow session state modification |
| **SUBAGENT_SPAWN** | Create sub-agent | Require approval for high-autonomy agents |
| **NODE_INVOKE** | Code evaluation | Require confirmation for dynamic eval |
| **BROWSER_AUTOMATE** | Browser control | Allow Playwright automation |
| **CRON_SCHEDULE** | Scheduled tasks | Require approval for critical schedules |
| **MESSAGE_EMIT** | Send messages | Allow email, require approval for mass send |
| **MEDIA_GENERATE** | Generate media | Allow image generation, rate-limit videos |
| **CANVAS_UI** | Canvas operations | Allow rendering, track performance |

### How It Works

```
1. OpenClaw decides to perform operation (e.g., make HTTP request)
2. ClarityBurst gate intercepts → loads ontology pack for NETWORK_IO stage
3. Derives allowed contracts (e.g., ["NET_HTTPS_GET", "NET_HTTPS_POST"])
4. Routes through ClarityBurst Router API → router selects best contract + confidence score
5. OpenClaw applies local thresholds (confidence ≥ 0.55, dominance ≥ 0.10)
6. If passed: PROCEED
   If HIGH/CRITICAL: ABSTAIN_CONFIRM (requires user approval)
   If failed: ABSTAIN_CLARIFY (operation blocked, fail-closed)
```

## Configuration

Set these environment variables when running OpenClaw:

```bash
# ClarityBurst Router service location
CLARITYBURST_ROUTER_URL=http://localhost:3001

# Request timeout (default 1200ms)
CLARITYBURST_ROUTER_TIMEOUT_MS=1200

# Enable/disable gating (true = enabled)
CLARITYBURST_ENABLED=true

# Log level
CLARITYBURST_LOG_LEVEL=info
```

## Testing

ClarityBurst integration includes **84+ tests**:

```bash
npm run verify  # Full test suite
```

Tests cover:
- ✅ Fail-closed policy (85 scenarios)
- ✅ Threshold boundaries (confidence, dominance)
- ✅ Pack isolation (packs don't interfere)
- ✅ Adversarial injection (prompt injection resistant)
- ✅ HTTP API (health, ready, routing endpoints)
- ✅ Router evaluation (100% accuracy on test cases)

---

## Why This Matters

### Without ClarityBurst
```
Agent → "I'll execute shell command" → Executes immediately
         ↓ (if malicious or buggy)
         💥 Data loss, security breach
```

### With ClarityBurst
```
Agent → "Execute shell command" → [ClarityBurst Gate]
                                    ├─ Load SHELL_EXEC pack
                                    ├─ Check: allowed?
                                    ├─ Route: which contract?
                                    ├─ Check: confident (0.92 > 0.60)?
                                    ├─ Check: HIGH risk? → require confirmation
                                    └─ RESULT: ABSTAIN_CONFIRM
                                       ↓
                                       (User approval required)
                                       ↓
                                       Execute safely
```

**Benefits:**
- 🛡️ Deterministic (not probabilistic)
- 🔒 Fail-closed (safe by default)
- 📊 Auditable (every decision logged)
- ⚡ Efficient (pre-dispatch validation, no wasted API calls)
- 🎛️ Controllable (ontology packs define policy)

---

## Directory Structure

```
openclaw/
├── clarityburst-docs/              # Full ClarityBurst documentation
│   ├── README.md                   # Documentation hub (start here)
│   ├── architecture/
│   │   ├── OPENCLAW_INTEGRATION.md ← How ClarityBurst integrates with OpenClaw
│   │   ├── OVERVIEW.md
│   │   ├── CONTROL_PLANE_ANALOGY.md
│   │   └── ... (more architecture docs)
│   ├── security/
│   │   ├── ENTERPRISE_SECURITY_SUMMARY.md
│   │   └── ... (threat modeling, hardening)
│   ├── validation/
│   │   ├── SECURITY_AUDIT_REPORT.md
│   │   └── ... (test results, validation)
│   ├── operations/
│   │   ├── QUICK_START.md
│   │   └── PRODUCTION_ROADMAP.md
│   └── ... (ontology, compliance, reference, archive)
│
├── src/clarityburst/               # Integration code in OpenClaw
│   ├── router-client.ts            # HTTP bridge to ClarityBurst Router
│   ├── decision-override.ts        # 12 gating stage functions
│   ├── config.ts                   # Configuration management
│   ├── pack-registry.ts            # Ontology pack loading
│   ├── allowed-contracts.ts        # Capability filtering
│   └── ... (tests, types)
│
└── CLARITYBURST_QUICKSTART.md      # This file
```

---

## Quick Links

| What do you need? | Link |
|---|---|
| **Understand integration** | [`architecture/OPENCLAW_INTEGRATION.md`](clarityburst-docs/architecture/OPENCLAW_INTEGRATION.md) |
| **Deploy to production** | [`operations/QUICK_START.md`](clarityburst-docs/operations/QUICK_START.md) |
| **Security review** | [`security/ENTERPRISE_SECURITY_SUMMARY.md`](clarityburst-docs/security/ENTERPRISE_SECURITY_SUMMARY.md) |
| **View all docs** | [`clarityburst-docs/README.md`](clarityburst-docs/README.md) |
| **See validation results** | [`validation/SECURITY_AUDIT_REPORT.md`](clarityburst-docs/validation/SECURITY_AUDIT_REPORT.md) |
| **Understand terminology** | [`reference/TERMINOLOGY.md`](clarityburst-docs/reference/TERMINOLOGY.md) |

---

## Status

✅ **Integration:** Complete and tested  
✅ **Security:** Audited and hardened  
✅ **Testing:** 84+ tests passing  
✅ **Documentation:** Comprehensive  
✅ **Production-Ready:** Yes

---

**Last Updated:** March 8, 2026  
**ClarityBurst Status:** Integrated in OpenClaw Fork  
**Router Version:** 1.0.0+
