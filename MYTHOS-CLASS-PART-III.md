# 🦞 OpenClaw → Mythos-Class — PART III
## The Operational Blueprint: Production Config, Workspace, Runbook & Final Synthesis

**Version**: 1.0.0 — 2026-07-20  
**Companions**: Part I (Architecture), Part II (Wire Protocols & Rust APIs)

---

## TABLE OF CONTENTS

1. [Complete Production Configuration (`openclaw.json`)](#i-complete-production-configuration)
2. [Environment Configuration (`.env`)](#ii-environment-configuration)
3. [Mythos Workspace File System](#iii-mythos-workspace-file-system)
4. [Fleet Agent SOUL Files](#iv-fleet-agent-soul-files)
5. [Lobster Workflow Specifications](#v-lobster-workflow-specifications)
6. [Cron Registry — Scheduled Automation](#vi-cron-registry--scheduled-automation)
7. [Operator Runbook](#vii-operator-runbook)
8. [Security Audit & Hardening Checklist](#viii-security-audit--hardening-checklist)
9. [Rust Integration Migration Plan](#ix-rust-integration-migration-plan)
10. [The 20 Laws of Mythos-Class — Final Canon](#x-the-20-laws-of-mythos-class)
11. [Complete System Topology Diagram](#xi-complete-system-topology-diagram)

---

## I. COMPLETE PRODUCTION CONFIGURATION

### `~/.openclaw/openclaw.json` — Mythos-Class Full Config

```json5
// ═══════════════════════════════════════════════════════════════
// MYTHOS-CLASS OPENCLAW CONFIGURATION
// Generated from source analysis: src/config/types.openclaw.ts
// ═══════════════════════════════════════════════════════════════
{
  "$schema": "https://docs.openclaw.ai/schema/openclaw.schema.json",

  "meta": {
    "lastTouchedVersion": "2026.5.10-beta.1",
    "lastTouchedAt": "2026-07-20T00:00:00Z"
  },

  // ─── AUTH ───────────────────────────────────────────────────
  "auth": {
    "gateway": {
      "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" },
      // Alternative: "password": { "source": "file", "id": "/run/secrets/gw-password" }
    },
    "mode": "token",
    // Device token rotation
    "deviceTokenRotation": {
      "enabled": true,
      "intervalDays": 30
    }
  },

  // ─── ENVIRONMENT ────────────────────────────────────────────
  "env": {
    "shellEnv": { "enabled": true, "timeoutMs": 15000 },
    "vars": {
      // Inline secrets (prefer SecretRef in production)
    }
  },

  // ─── GATEWAY ────────────────────────────────────────────────
  "gateway": {
    "port": 18789,
    "bind": "loopback",  // "loopback" | "lan" | "tailscale" | "all"
    "auth": {
      "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" }
    },
    // TLS for remote access (via Tailscale Serve)
    "tls": {
      "enabled": false,  // Enable for non-Tailscale remote
      "cert": "/run/secrets/gateway.crt",
      "key": "/run/secrets/gateway.key"
    },
    // Discovery
    "discovery": {
      "bonjour": { "enabled": true },
      "tailscale": { "enabled": false }
    },
    // Diagnostics
    "diagnostics": {
      "enabled": true,
      "timeline": true,
      "payloadLarge": true
    },
    // Talk/Voice
    "talk": {
      "provider": "openai",
      "providers": {
        "openai": {
          "model": "gpt-realtime-2.1",
          "voice": "cedar",
          "transport": "webrtc"
        },
        "elevenlabs": {
          "voiceId": { "source": "env", "id": "ELEVENLABS_VOICE_ID" },
          "modelId": "eleven_v3",
          "outputFormat": "mp3_44100_128"
        }
      },
      "realtime": {
        "mode": "realtime",
        "transport": "webrtc",
        "brain": "agent-consult"
      },
      "silenceTimeoutMs": 1500,
      "interruptOnSpeech": true
    }
  },

  // ─── UI ─────────────────────────────────────────────────────
  "ui": {
    "seamColor": "#ff6600",
    "assistant": {
      "name": "Mythos",
      "avatar": "🏛️"
    }
  },

  // ─── MODELS ─────────────────────────────────────────────────
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "env", "id": "ANTHROPIC_API_KEY" },
        "models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-3-5"]
      },
      "openai": {
        "apiKey": { "source": "env", "id": "OPENAI_API_KEY" },
        "models": ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-realtime-2.1"]
      },
      "google": {
        "apiKey": { "source": "env", "id": "GEMINI_API_KEY" },
        "models": ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-embedding-004"]
      },
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "models": ["nemotron-70b", "llama-3.3-70b"]
      }
    },
    // Model aliases
    "aliases": {
      "opus": "anthropic/claude-opus-4-7",
      "sonnet": "anthropic/claude-sonnet-4-6",
      "gpt": "openai/gpt-5.5",
      "gpt-mini": "openai/gpt-5.4-mini",
      "gemini": "google/gemini-3.1-pro-preview",
      "gemini-flash": "google/gemini-3-flash-preview"
    },
    // Failover chains
    "failover": [
      { "primary": "anthropic/claude-opus-4-7", "fallback": "openai/gpt-5.5" },
      { "primary": "google/gemini-3-flash-preview", "fallback": "openai/gpt-5.4-mini" }
    ],
    // Budget controls
    "budget": {
      "tokensPerHour": 500000,
      "costPerHour": "$5.00",
      "hardCap": true
    }
  },

  // ─── AGENTS ─────────────────────────────────────────────────
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/mythos/fleet/PRIME",
      "bootstrapMaxChars": 20000,
      "bootstrapTotalMaxChars": 60000,
      "sandbox": true,
      "workspaceAccess": "rw",
      "maxConcurrent": 3,
      "subagentMaxConcurrent": 5,
      // Memory search
      "memorySearch": {
        "provider": "local",
        "local": {
          "modelPath": "~/.cache/gguf/embeddinggemma-300M-Q8_0.gguf",
          "fallback": "openai"
        },
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3,
          "mmrDiversification": true,
          "temporalDecayHalflife": "30d"
        },
        "store": {
          "path": "~/.openclaw/memory/{agentId}.sqlite"
        },
        "experimental": {
          "sessionMemory": true
        },
        "sources": ["memory", "sessions", "wiki"]
      },
      // Compaction
      "compaction": {
        "thresholdTokens": 150000,
        "strategy": "summarize+flush"
      }
    },
    // Per-agent configurations
    "entries": {
      "prime": {
        "workspace": "~/.openclaw/mythos/fleet/PRIME",
        "model": "anthropic/claude-opus-4-7",
        "label": "Mythos Prime"
      },
      "research": {
        "workspace": "~/.openclaw/mythos/fleet/RESEARCH",
        "model": "google/gemini-3-flash-preview",
        "label": "Mythos Research"
      },
      "code": {
        "workspace": "~/.openclaw/mythos/fleet/CODE",
        "model": "anthropic/claude-opus-4-7",
        "label": "Mythos Code"
      },
      "ops": {
        "workspace": "~/.openclaw/mythos/fleet/OPS",
        "model": "anthropic/claude-sonnet-4-6",
        "label": "Mythos Ops"
      },
      "memory": {
        "workspace": "~/.openclaw/mythos/fleet/MEMORY",
        "model": "anthropic/claude-haiku-3-5",
        "label": "Mythos Memory"
      },
      "critic": {
        "workspace": "~/.openclaw/mythos/fleet/CRITIC",
        "model": "anthropic/claude-opus-4-7",
        "label": "Mythos Critic"
      }
    }
  },

  // ─── MEMORY ─────────────────────────────────────────────────
  "memory": {
    "backend": "builtin",  // "builtin" | "qmd"
    "qmd": {
      "sessions": { "enabled": true },
      "rerank": true,
      "searchMode": "hybrid"
    }
  },

  // ─── TOOLS ──────────────────────────────────────────────────
  "tools": {
    "profile": "default",
    "alsoAllow": [],
    "deny": [],
    // Exec approval
    "exec": {
      "security": "default",
      "ask": "risky",
      "askFallback": "always",
      "autoAllowSkills": false
    }
  },

  // ─── BROWSER ────────────────────────────────────────────────
  "browser": {
    "enabled": true,
    "profile": "openclaw",
    "profiles": {
      "openclaw": {
        "driver": "managed",
        "chromeArgs": ["--disable-gpu", "--no-sandbox"]
      },
      "research": {
        "driver": "managed"
      },
      "work": {
        "driver": "existing-session",
        "cdpUrl": "http://127.0.0.1:9222"
      }
    },
    "ssrf": {
      "strict": true,
      "allowedHosts": ["*.internal.company.com", "localhost"]
    }
  },

  // ─── MCP SERVERS ────────────────────────────────────────────
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": { "source": "env", "id": "GITHUB_TOKEN" }
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": { "source": "env", "id": "PG_URL" }
      }
    },
    "browser": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-puppeteer"]
    }
  },

  // ─── PLUGINS ────────────────────────────────────────────────
  "plugins": {
    "entries": {
      // Memory Core + Dreaming
      "memory-core": {
        "enabled": true,
        "config": {
          "dreaming": {
            "enabled": true,
            "frequency": "0 */3 * * *",
            "timezone": "UTC",
            "model": "anthropic/claude-haiku-3-5",
            "deep": {
              "minScore": 0.75,
              "minRecallCount": 2,
              "minUniqueQueries": 2
            },
            "weights": {
              "relevance": 0.30,
              "frequency": 0.24,
              "queryDiv": 0.15,
              "recency": 0.15,
              "consolidation": 0.10,
              "conceptRich": 0.06
            },
            "storage": { "mode": "both" }
          }
        }
      },
      // Memory Wiki
      "memory-wiki": {
        "enabled": true,
        "config": {
          "mode": "bridge",
          "createDashboards": true,
          "provenance": true
        }
      },
      // OpenShell Sandbox
      "openshell": {
        "enabled": true,
        "config": {
          "policyDir": "~/.openclaw/nemoclaw/policies",
          "failClosed": true
        }
      },
      // Webhooks
      "webhooks": {
        "enabled": true,
        "config": {
          "routes": {
            "github_ci": {
              "path": "/plugins/webhooks/github-ci",
              "sessionKey": "agent:code:webhook:github",
              "secret": { "source": "env", "id": "GITHUB_WEBHOOK_SECRET" },
              "controllerId": "webhooks/github-ci"
            }
          }
        }
      },
      // Lobster Workflows
      "lobster": {
        "enabled": true
      },
      // Browser
      "browser": {
        "enabled": true
      },
      // Canvas
      "canvas": {
        "enabled": true
      }
    }
  },

  // ─── CHANNELS ───────────────────────────────────────────────
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "source": "env", "id": "TELEGRAM_BOT_TOKEN" },
      "allowFrom": ["12345678"]
    },
    "discord": {
      "enabled": true,
      "botToken": { "source": "env", "id": "DISCORD_BOT_TOKEN" },
      "guildId": "123456789"
    },
    "slack": {
      "enabled": true,
      "botToken": { "source": "env", "id": "SLACK_BOT_TOKEN" },
      "appToken": { "source": "env", "id": "SLACK_APP_TOKEN" }
    }
  },

  // ─── BINDINGS ───────────────────────────────────────────────
  "bindings": [
    {
      "channel": "telegram",
      "agentId": "prime",
      "scope": "dm"
    },
    {
      "channel": "discord",
      "agentId": "prime",
      "scope": "all"
    },
    {
      "channel": "slack",
      "agentId": "ops",
      "scope": "channel:#ops"
    }
  ],

  // ─── CRON ───────────────────────────────────────────────────
  "cron": {
    "enabled": true,
    "timezone": "UTC"
  },

  // ─── HOOKS ──────────────────────────────────────────────────
  "hooks": {
    "internal": {
      "enabled": true
    }
  },

  // ─── SKILLS ─────────────────────────────────────────────────
  "skills": {
    "install": {
      "allowUploadedArchives": false,
      "requireSignedManifest": true
    }
  },

  // ─── SECRETS ────────────────────────────────────────────────
  "secrets": {
    "resolution": {
      "env": { "enabled": true },
      "file": { "enabled": true },
      "exec": { "enabled": false }
    }
  },

  // ─── ACP ────────────────────────────────────────────────────
  "acp": {
    "provenanceMode": "meta+receipt",
    "sessionCreateRateLimit": {
      "maxRequests": 10,
      "windowMs": 60000
    }
  },

  // ─── UPDATE ─────────────────────────────────────────────────
  "update": {
    "channel": "stable",
    "checkOnStart": true,
    "auto": {
      "enabled": false,
      "stableDelayHours": 6
    }
  },

  // ─── COMMITMENTS ────────────────────────────────────────────
  "commitments": {
    "enabled": true,
    "inferenceModel": "google/gemini-3-flash-preview"
  }
}
```

---

## II. ENVIRONMENT CONFIGURATION

### `~/.openclaw/.env`

```bash
# ═══════════════════════════════════════════════════════════════
# MYTHOS-CLASS ENVIRONMENT
# ═══════════════════════════════════════════════════════════════

# ─── GATEWAY AUTH ─────────────────────────────────────────────
OPENCLAW_GATEWAY_TOKEN=<openssl-rand-hex-32-output>

# ─── MODEL PROVIDER KEYS ──────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...

# ─── CHANNEL KEYS ─────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=123456:ABC-...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# ─── GITHUB ───────────────────────────────────────────────────
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=<random-hex>

# ─── MCP SERVERS ──────────────────────────────────────────────
PG_URL=postgresql://user:pass@localhost:5432/mythos

# ─── VOICE ────────────────────────────────────────────────────
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...

# ─── OPTIONAL ─────────────────────────────────────────────────
# OPENCLAW_STATE_DIR=~/.openclaw
# OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json
# OPENCLAW_LOAD_SHELL_ENV=1
# OPENCLAW_DISABLE_BONJOUR=
# OPENCLAW_GATEWAY_STARTUP_TRACE=1

# ─── OBSERVABILITY ────────────────────────────────────────────
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# OTEL_SERVICE_NAME=mythos-gateway
```

---

## III. MYTHOS WORKSPACE FILE SYSTEM

```
~/.openclaw/mythos/
├── fleet/
│   ├── PRIME/                          # Orchestrator Agent
│   │   ├── SOUL.md                     # Identity & values
│   │   ├── AGENTS.md                   # Operating instructions & delegation rules
│   │   ├── USER.md                     # Human profile
│   │   ├── TOOLS.md                    # Environment-specific tool info
│   │   ├── IDENTITY.md                 # Name: "Mythos" | Emoji: 🏛️
│   │   ├── MEMORY.md                   # Long-term curated memory
│   │   ├── HEARTBEAT.md               # Periodic check instructions
│   │   ├── BOOT.md                     # Startup hooks
│   │   ├── DREAMS.md                   # Dream diary (human review)
│   │   ├── memory/
│   │   │   ├── 2026-07-20.md           # Daily logs
│   │   │   ├── 2026-07-19.md
│   │   │   └── archive/               # Old logs (>30 days)
│   │   ├── checklists/
│   │   │   ├── deploy-agent.md
│   │   │   ├── gateway-restart.md
│   │   │   └── incident-response.md
│   │   └── docs/                       # On-demand docs (NOT auto-loaded)
│   │
│   ├── RESEARCH/                       # Research Agent
│   │   ├── AGENTS.md                   # Research-focused instructions
│   │   ├── TOOLS.md                    # web_search, web_fetch, memory_search
│   │   └── memory/
│   │       └── 2026-07-20.md
│   │
│   ├── CODE/                           # Coding Agent
│   │   ├── AGENTS.md                   # Code-focused instructions
│   │   ├── TOOLS.md                    # exec, write, read, edit, browser
│   │   └── memory/
│   │
│   ├── OPS/                            # Operations Agent
│   │   ├── AGENTS.md                   # Infrastructure instructions
│   │   ├── TOOLS.md                    # exec, cron, gateway management
│   │   └── memory/
│   │
│   ├── MEMORY/                         # Memory Agent
│   │   ├── AGENTS.md                   # Memory management instructions
│   │   ├── TOOLS.md                    # memory_*, wiki_*
│   │   └── memory/
│   │
│   └── CRITIC/                         # Critic Agent
│       ├── AGENTS.md                   # Validation & audit instructions
│       ├── TOOLS.md                    # read, security audit
│       └── memory/
│
├── shared/
│   ├── wiki/                           # memory-wiki vault (bridge mode)
│   │   ├── DASHBOARD.md               # Wiki dashboard
│   │   ├── pages/
│   │   │   ├── architecture/
│   │   │   ├── decisions/
│   │   │   └── people/
│   │   └── evidence/                   # Provenance chains
│   ├── DREAMS.md                       # Cross-agent dream diary
│   └── audit/                          # Cryptographic audit log
│
├── nemoclaw/
│   ├── policies/                       # Per-agent YAML policies
│   │   ├── prime.yaml
│   │   ├── code.yaml
│   │   ├── research.yaml
│   │   ├── ops.yaml
│   │   ├── memory.yaml
│   │   └── critic.yaml
│   └── sandboxes/                      # K3s PVC mounts
│
└── workflows/
    ├── github-triage.lobster           # GitHub issue triage workflow
    ├── daily-brief.lobster             # Daily intelligence briefing
    ├── incident-response.lobster       # Incident response workflow
    └── weekly-retro.lobster            # Weekly retrospective
```

---

## IV. FLEET AGENT SOUL FILES

### PRIME — `fleet/PRIME/SOUL.md`

```markdown
# SOUL — Mythos Prime

## Identity
You are Mythos Prime, the orchestrator of a multi-agent cognitive system.
You do not do leaf work — you delegate, synthesize, and ensure quality.

## Core Values
- **Precision**: Every output must be correct, not just plausible.
- **Economy**: Use the cheapest model that can do the job well.
- **Transparency**: Always explain your reasoning and delegation choices.
- **Safety**: Never execute destructive actions without human approval.

## Behavioral Boundaries
- You never call exec/bash directly — delegate to CODE or OPS agents.
- You never bypass the approval system.
- You always write audit entries for significant decisions.
- You always check MEMORY.md before starting new work.

## Delegation Rules
1. Classification/routing → use Gemini Flash (cheap, fast)
2. Complex reasoning/planning → handle yourself (Opus)
3. Code generation → delegate to CODE agent (Opus via ACP)
4. Research tasks → delegate to RESEARCH agent (Flash)
5. Memory operations → delegate to MEMORY agent (Haiku)
6. Validation → delegate to CRITIC agent (Opus)

## Cost Awareness
- Flash model: $0.001/1K tokens — use freely for triage
- Sonnet model: $0.003/1K tokens — use for standard work
- Opus model: $0.015/1K tokens — reserve for complex reasoning
- Local model: $0.00 — use for sensitive/regulated data
```

### PRIME — `fleet/PRIME/AGENTS.md`

```markdown
# AGENTS.md — Mythos Prime Operating Manual

## Fleet Topology
You command a fleet of specialized agents:
- **RESEARCH** — Web search, document analysis, RAG
- **CODE** — Software engineering via ACP/codex harness
- **OPS** — Infrastructure, monitoring, shell tasks
- **MEMORY** — Memory consolidation, wiki management
- **CRITIC** — Validation, audit, adversarial probing

## Delegation Protocol
1. Task arrives via any channel
2. Classify task type and complexity
3. Route via `/acp spawn` to appropriate agent
4. Worker executes in isolated session
5. Worker delivers result back to you
6. You synthesize and respond
7. You write audit entry → MEMORY agent indexes

## Standing Orders
- Check urgent messages at start of each session
- Post fleet status to #ops-discord every heartbeat if >3 agents active
- Escalate any sub-agent silent >2hrs immediately
- Switch all routing to flash model if budget >80% of hourly cap

## Memory Rules
- Daily log: memory/YYYY-MM-DD.md
- Long-term: MEMORY.md (curated facts only)
- Read today + yesterday + MEMORY.md on session start
- Before writing, always read first
- Capture: decisions, preferences, constraints, open loops
```

### PRIME — `fleet/PRIME/HEARTBEAT.md`

```markdown
# HEARTBEAT.md — Mythos Prime

## Every Heartbeat (30 min)
- [ ] Check memory/heartbeat-state.json for pending delegations
- [ ] Scan for ACP sessions reporting completion
- [ ] Review COMMITMENTS due in next 2 hours
- [ ] Check fleet agent health
- [ ] If >3 sub-agents active: post fleet status to #ops

## Escalation Rules
- Sub-agent silent >2hrs → alert ops channel
- Budget >80% hourly cap → switch all to flash model
- Dreaming phase failure → flag in DREAMS.md

## Standing Checks (rotate)
Cycle A: Email triage + Calendar
Cycle B: GitHub PR queue + CI status
Cycle C: Slack unread + Notion updates
Cycle D: Memory index health + Wiki lint

NEVER reply HEARTBEAT_OK — always post a status summary.
```

---

## V. LOBSTER WORKFLOW SPECIFICATIONS

### `workflows/github-triage.lobster`

```yaml
name: github-issue-triage
version: "1.0.0"
description: "Automated GitHub issue triage and response"

trigger:
  type: webhook
  path: /plugins/webhooks/github-ci
  secret: { source: env, id: GITHUB_WEBHOOK_SECRET }

steps:
  - id: classify
    agent: prime
    prompt: |
      Classify this GitHub issue:
      Title: {{payload.issue.title}}
      Body: {{payload.issue.body}}
      Labels: {{payload.issue.labels}}

      Determine: bug/feature/question/spam
      Priority: critical/high/medium/low
      Estimated complexity: simple/moderate/complex
    depends_on: []
    model: google/gemini-3-flash-preview  # cheap for classification

  - id: research_context
    agent: research
    prompt: |
      Research context for issue #{{payload.issue.number}}:
      - Search related issues and PRs
      - Check if this is a duplicate
      - Find relevant code sections
      - Check recent changes to affected files
    depends_on: [classify]
    tools: [web_search, web_fetch, memory_search, read]

  - id: draft_response
    agent: code
    prompt: |
      Based on the classification and research:
      - Draft an appropriate response
      - If bug: include reproduction steps and fix suggestion
      - If feature: acknowledge and add to roadmap
      - If question: provide clear answer with references
    depends_on: [research_context]
    model: anthropic/claude-opus-4-7

  - id: review
    agent: critic
    prompt: |
      Review the drafted response for:
      - Accuracy and completeness
      - Tone appropriateness
      - Security concerns (no leaked secrets)
      - Links validity
    depends_on: [draft_response]

  - id: post_response
    agent: ops
    prompt: |
      Post the reviewed response to GitHub issue #{{payload.issue.number}}.
      Apply appropriate labels based on classification.
      Notify relevant team members if high/critical priority.
    depends_on: [review]
    deliver:
      - github:comment
      - slack:eng-team  # if priority is high/critical
```

### `workflows/daily-brief.lobster`

```yaml
name: daily-intelligence-briefing
version: "1.0.0"
description: "Compile daily intelligence briefing"

trigger:
  type: cron
  schedule: "0 7 * * *"
  timezone: "UTC"

steps:
  - id: gather_news
    agent: research
    prompt: |
      Gather today's intelligence:
      - Technology news relevant to our projects
      - GitHub activity (PRs merged, issues opened)
      - Security advisories for our dependencies
      - Calendar events for today
      - Unread emails marked important
    tools: [web_search, web_fetch, memory_search]
    model: google/gemini-3-flash-preview

  - id: compile_brief
    agent: prime
    prompt: |
      Compile a concise daily briefing from the gathered intelligence.
      Format:
      ## 🌅 Daily Brief — {{date}}
      ### 🔥 Priority Items
      ### 📊 Project Status
      ### 📅 Today's Calendar
      ### 📧 Key Messages
      ### 🔒 Security Notes
    depends_on: [gather_news]
    model: anthropic/claude-sonnet-4-6

  - id: deliver
    agent: ops
    prompt: |
      Deliver the briefing to:
      - Telegram (main session)
      - Slack (#general)
      - Discord (#briefings)
    depends_on: [compile_brief]
    deliver:
      - telegram:prime
      - slack:general
      - discord:briefings
```

---

## VI. CRON REGISTRY — SCHEDULED AUTOMATION

```bash
# ═══════════════════════════════════════════════════════════════
# MYTHOS-CLASS CRON REGISTRY
# ═══════════════════════════════════════════════════════════════

# Daily intelligence briefing — 07:00 UTC
openclaw cron add \
  --name "Daily Brief" \
  --schedule "0 7 * * *" --tz UTC \
  --session isolated \
  --model google/gemini-3-flash-preview \
  --system-event "Run daily-brief.lobster workflow" \
  --deliver telegram:prime,slack:general

# GitHub PR sweep — every 15 min during work hours
openclaw cron add \
  --name "PR Triage" \
  --schedule "*/15 9-18 * * 1-5" --tz "Europe/Vienna" \
  --session "session:github-triage" \
  --model google/gemini-3-flash-preview \
  --system-event "Check open PRs needing review or response"

# Dreaming cycle — every 3 hours (plugin-managed, not cron)
# Configured in plugins.entries.memory-core.config.dreaming

# Wiki compilation — 02:00 daily
openclaw cron add \
  --name "Wiki Compile" \
  --schedule "0 2 * * *" --tz UTC \
  --session isolated \
  --model anthropic/claude-haiku-3-5 \
  --system-event "Run wiki_lint, compile knowledge pages, update DASHBOARD.md"

# Security audit — Sunday 03:00
openclaw cron add \
  --name "Security Audit" \
  --schedule "0 3 * * 0" --tz UTC \
  --session isolated \
  --model anthropic/claude-opus-4-7 \
  --system-event "Run security audit: skill signatures, gateway logs, CVE check"

# Weekly retrospective — Friday 18:00
openclaw cron add \
  --name "Weekly Retro" \
  --schedule "0 18 * * 5" --tz UTC \
  --session isolated \
  --model anthropic/claude-opus-4-7 \
  --system-event "Generate weekly summary, lessons learned, next week priorities" \
  --deliver telegram:prime,slack:team

# Cache warm-up — every 25 minutes
openclaw cron add \
  --name "Cache Warm" \
  --schedule "*/25 * * * *" \
  --session main \
  --system-event "Heartbeat cache warm." \
  --wake next-heartbeat
```

---

## VII. OPERATOR RUNBOOK

### Section A — Daily Operations

```bash
# Morning health check
openclaw doctor --deep
openclaw memory status
openclaw agents list

# Check dreaming ran overnight
openclaw memory rem-harness | head -20
cat ~/.openclaw/mythos/fleet/PRIME/DREAMS.md | tail -50

# Check overnight cron jobs
openclaw cron list --status completed --since yesterday

# Review workboard
openclaw workboard list --status open
```

### Section B — Memory Operations

```bash
# Force immediate memory reindex
openclaw memory index --all --force

# Semantic search test
openclaw memory search --query "gateway authentication" --sources all

# Preview dreaming candidates (no write)
openclaw memory rem-harness

# Explain promotion decision
openclaw memory promote-explain "candidate-slug"

# Manually promote to MEMORY.md
openclaw memory promote --preview
openclaw memory promote --apply

# Wiki operations
openclaw wiki status
openclaw wiki lint
openclaw wiki compile
```

### Section C — Fleet Management

```bash
# List all running ACP sessions
openclaw agents list --type acp

# Spawn research sub-agent
/acp spawn "Research latest RFC on HTTP/3, write summary to memory"

# Check ACP session status
/acp list

# Steer active agent
/acp steer <session-id> "Also check the QUIC implementation notes"

# Attach to sub-agent output
/acp attach <session-id>

# Gateway restart (safe — no session loss)
openclaw gateway restart

# Reload secrets without restart
openclaw secrets reload

# Apply config patch
openclaw config set agents.defaults.memorySearch.hybrid.vectorWeight 0.8
```

### Section D — Browser Operations

```bash
# Check browser health
openclaw browser doctor --deep
openclaw browser status

# Start headless for CI
openclaw browser start --headless

# Get accessibility tree snapshot
openclaw browser snapshot --format ai

# Take full-page screenshot
openclaw browser screenshot --full-page

# Switch profile
openclaw browser --browser-profile research status
```

### Section E — Incident Response

```bash
# Agent stuck in infinite loop
/stop                           # From chat
openclaw gateway restart        # If /stop fails
openclaw agents reset --session main  # Full session reset

# Memory corruption suspected
openclaw memory index --rebuild  # Rebuild from scratch

# Config corrupted
openclaw config schema validate
openclaw backup verify latest
openclaw backup restore latest --confirm

# Gateway won't start
openclaw doctor --fix
launchctl list | grep openclaw
launchctl kickstart -k gui/$UID/ai.openclaw.gateway

# High token costs (runaway agent)
openclaw status --usage
# Emergency: switch all to flash
openclaw config set models.aliases.opus google/gemini-3-flash-preview
openclaw gateway restart

# Skill supply chain concern
openclaw skills workshop list
openclaw skills workshop inspect
openclaw skills workshop quarantine --skill @suspect/skill
```

---

## VIII. SECURITY AUDIT & HARDENING CHECKLIST

```bash
# Full security audit
openclaw security audit

# Specific checks:
# ✅ Gateway binds to loopback only (not 0.0.0.0)
# ✅ Gateway token is strong (≥32 hex chars, not example values)
# ✅ No dangerous config flags enabled
# ✅ Exec approval is configured (ask: "risky")
# ✅ Browser SSRF strict mode enabled
# ✅ Skills require signed manifests
# ✅ No uploaded archives allowed
# ✅ Plugin trust evaluated
# ✅ Channel allowlists configured
# ✅ Node command policy set
# ✅ Secrets not in plaintext in config
# ✅ Config file permissions: 600
# ✅ State dir not in cloud-synced folder
```

### Gateway Exposure Matrix

| Bind Mode | Accessible From | Use Case |
|---|---|---|
| `loopback` | localhost only | Default, most secure |
| `lan` | Local network | Home/office deployments |
| `tailscale` | Tailscale mesh | Remote access |
| `all` | Public internet | ⚠️ Requires TLS + strong auth |

---

## IX. RUST INTEGRATION MIGRATION PLAN

### Phase 1: Foundation (Months 1-2)

```
Priority: P0 — Vector Search + Full-Text Search

Week 1-2:
  ✅ Create Cargo workspace at crates/
  ✅ Implement mythos-vector-engine (HNSW via usearch)
  ✅ NAPI-RS bindings with TypeScript types
  ✅ Unit tests matching existing manager-search.test.ts

Week 3-4:
  ✅ Implement mythos-search-engine (Tantivy BM25)
  ✅ Custom tokenizers (CJK, code, natural language)
  ✅ Integration tests against existing memory test suite

Week 5-6:
  ✅ Build hybrid search combining both engines
  ✅ Graceful fallback (native → JS) if module fails to load
  ✅ Benchmark: confirm 10x+ improvement on real data

Week 7-8:
  ✅ Integration into extensions/memory-core/src/memory/
  ✅ Replace manager-search.ts searchVector() calls
  ✅ Replace hybrid.ts BM25 calls
  ✅ Validate with full test suite
```

### Phase 2: Performance (Months 3-4)

```
Priority: P1 — Embedding Runtime + Sandbox

Week 9-10:
  ✅ Implement mythos-embedding-runtime (Candle + GGUF)
  ✅ Metal backend for Apple Silicon
  ✅ CUDA backend for NVIDIA GPUs
  ✅ Batch embedding API

Week 11-12:
  ✅ Implement mythos-execution-sandbox
  ✅ seccomp-bpf syscall filtering
  ✅ Filesystem capability model
  ✅ Network policy enforcement

Week 13-16:
  ✅ Replace node-llama-cpp for local embeddings
  ✅ Replace openshell CLI with native sandbox
  ✅ Integration testing
  ✅ Performance validation
```

### Phase 3: Intelligence (Months 5-6)

```
Priority: P2 — Protocol Codec + Causal Graph

Week 17-18:
  ✅ Implement mythos-protocol-codec (simd-json)
  ✅ Zero-copy frame parsing
  ✅ Integration into gateway WS hot path

Week 19-22:
  ✅ Implement mythos-causal-graph (petgraph)
  ✅ Causal relationship tracking
  ✅ Temporal reasoning queries
  ✅ CRDT merge for multi-agent consistency

Week 23-24:
  ✅ L7 memory integration
  ✅ Full system validation
  ✅ Production deployment
```

### Build System Integration

```json
// Add to root package.json:
{
  "scripts": {
    "build:rust": "cargo build --release --workspace",
    "build:rust:debug": "cargo build --workspace",
    "test:rust": "cargo test --workspace",
    "build:all": "pnpm build:rust && pnpm build"
  },
  "optionalDependencies": {
    "@openclaw/mythos-vector-engine": "file:crates/mythos-vector-engine",
    "@openclaw/mythos-search-engine": "file:crates/mythos-search-engine",
    "@openclaw/mythos-execution-sandbox": "file:crates/mythos-execution-sandbox",
    "@openclaw/mythos-protocol-codec": "file:crates/mythos-protocol-codec",
    "@openclaw/mythos-causal-graph": "file:crates/mythos-causal-graph",
    "@openclaw/mythos-embedding-runtime": "file:crates/mythos-embedding-runtime"
  }
}
```

---

## X. THE 20 LAWS OF MYTHOS-CLASS — FINAL CANON

| # | Law | One-Line Specification | Source |
|---|---|---|---|
| **1** | **Gateway Inversion** | The brain is a plugin; the gateway is the product | `src/gateway/server.impl.ts` |
| **2** | **Model Arbitrage** | Flash for routing, Opus for reasoning, local for secrets | `src/agents/runtime-plan/build.ts` |
| **3** | **7-Layer Memory** | Every cognitive need has a dedicated memory layer | `extensions/memory-core/src/memory/` |
| **4** | **Dreaming Always-On** | Agents must consolidate while humans sleep | `extensions/memory-core/src/memory/dreaming.ts` |
| **5** | **Protocol-Level Browser** | Accessibility tree > screenshot; CDP > visual inference | `extensions/browser/src/` |
| **6** | **Bundled Recovery Loops** | Skills encode failure recovery, not just happy paths | `src/agents/tools/` |
| **7** | **TaskFlow for All Work** | Nothing important lives in a single session | `src/tasks/task-flow-registry.ts` |
| **8** | **MCP Bidirectionality** | Consume AND expose; 200+ ecosystem tools in both directions | `src/mcp/` |
| **9** | **Skill Determinism** | Bounded iteration, explicit contracts, no infinite loops | `src/agents/pi-embedded-runner/run.ts` |
| **10** | **Canvas as App Layer** | Agents build UIs, not just text | `extensions/canvas/` |
| **11** | **Kernel-Level Security** | OS sandbox beats model-level guardrails every time | `extensions/openshell/` |
| **12** | **Session Branching** | Every high-stakes action must be reversible | `src/agents/pi-embedded-runner/compact.ts` |
| **13** | **Webhook-First Triggers** | External systems own the trigger, not cron alone | `extensions/webhooks/` |
| **14** | **The Agent IS the Files** | Identity, memory, and behavior live in plain text | `~/.openclaw/workspace/*.md` |
| **15** | **Nodes Give Agents a Body** | Camera + location + voice = embodied agent | `src/gateway/protocol/schema/nodes.ts` |
| **16** | **Approval Gates at the Edge** | Exec approval before any destructive shell action | `src/gateway/exec-approval-manager.ts` |
| **17** | **Pairing Before Presence** | No node enters the fleet without explicit approval | `src/gateway/node-pairing-auto-approve.ts` |
| **18** | **Loopback by Default** | Port 18789 never faces the public internet | `src/gateway/server-network-runtime.ts` |
| **19** | **ClawHub Trust Chain** | No skill enters the fleet without SkillSpector + signed manifest | `src/security/skill-scanner.ts` |
| **20** | **Rust at the Boundaries** | Native code at every I/O and compute boundary | `crates/mythos-*` |

---

## XI. COMPLETE SYSTEM TOPOLOGY DIAGRAM

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║                    MYTHOS-CLASS OPENCLAW — COMPLETE TOPOLOGY                          ║
║                              (July 2026 — Rust Polyglot)                              ║
╠═══════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                       ║
║  WORLD SURFACE (Input/Output)                                                          ║
║  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐      ║
║  │WhatsApp│ │Telegram│ │Discord │ │ Slack  │ │ GitHub │ │ Email  │ │ Web UI │      ║
║  │Baileys │ │ grammY │ │d.js    │ │ Bolt   │ │Webhooks│ │IMAP/SMTP│ │Control │      ║
║  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘      ║
║      └──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘             ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  GATEWAY (127.0.0.1:18789)              │                                              ║
║  ┌──────────────────────────────────────┼─────────────────────────────────────┐        ║
║  │  WS Server │ HTTP Server │ Channel Router │ Session Manager │ Event Bus    │        ║
║  │  Cron Scheduler │ Hook Engine │ TaskFlow Orchestrator │ Plugin Runtime     │        ║
║  │  Canvas Host (:18793, A2UI v0.8) │ Webhook Routes │ Talk/Voice Relay      │        ║
║  │  MCP Dual-Role (3 surfaces) │ Device Pairing │ Auth/Challenge             │        ║
║  │  ┌────────────────────────────────────────────────────────────────────┐   │        ║
║  │  │ 🦀 RUST PROTOCOL CODEC (simd-json, zero-copy WS frames)          │   │        ║
║  │  └────────────────────────────────────────────────────────────────────┘   │        ║
║  └───────────────────────────────────────────────────────────────────────────┘        ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  MODEL ARBITRAGE LAYER                  │                                              ║
║  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐         ║
║  │ TRIAGE     │ │ REASONING  │ │  CODING    │ │  SENSITIVE │ │  EMBEDDING │         ║
║  │Gemini Flash│ │Claude Opus │ │Claude Opus │ │ Nemotron   │ │ Gemma 300M│         ║
║  │ ~$0.001/1K │ │ ~$0.015/1K │ │ ~$0.015/1K │ │ LOCAL/FREE │ │ LOCAL/FREE│         ║
║  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘         ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  AGENT FLEET (Supervisor-Worker + ACP)  │                                              ║
║  ┌──────────────────────────────────────┼───────────────────────────────────┐          ║
║  │ PRIME (Orchestrator)                │                                    │          ║
║  │  └─ Classifies → Routes → Synthesizes → Audits                         │          ║
║  └──────────────┬───────────────────────────────────────────────────────────┘          ║
║       ┌─────────┼─────────┬──────────┬──────────┐                                     ║
║  ┌────┴───┐ ┌───┴────┐ ┌─┴──────┐ ┌─┴───────┐ ┌┴────────┐                            ║
║  │RESEARCH│ │ CODE   │ │  OPS   │ │ MEMORY  │ │ CRITIC  │                            ║
║  │Web+RAG │ │ACP/    │ │Shell+  │ │Dreaming │ │Audit+   │                            ║
║  │        │ │Codex   │ │Infra   │ │Wiki     │ │Probe    │                            ║
║  └────────┘ └────────┘ └────────┘ └─────────┘ └─────────┘                            ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  🦀 RUST NATIVE LAYER                 │                                              ║
║  ┌──────────────────────────────────────┼─────────────────────────────────────┐        ║
║  │ mythos-vector-engine  │ HNSW (usearch)      │ 100x vector search          │        ║
║  │ mythos-search-engine  │ Tantivy BM25        │ 10x full-text search        │        ║
║  │ mythos-embed-runtime  │ Candle (GPU)        │ 50x local embedding         │        ║
║  │ mythos-causal-graph   │ petgraph            │ L7 causal memory (new)      │        ║
║  │ mythos-exec-sandbox   │ seccomp-bpf         │ 100x sandbox perf           │        ║
║  │ mythos-protocol-codec │ simd-json           │ 5x WS throughput            │        ║
║  └───────────────────────────────────────────────────────────────────────────┘        ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  EXECUTION LAYER                       │                                              ║
║  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     ║
║  │ Browser  │ │ Canvas   │ │  Shell   │ │  MCP     │ │  Nodes   │ │ Lobster  │     ║
║  │ CDP+PW   │ │ A2UI     │ │ Sandboxed│ │200+ svrs │ │iOS/Andr  │ │ Workflows│     ║
║  │ SSRF-safe│ │ :18793   │ │ OpenShell│ │stdio+SSE │ │Camera    │ │ YAML     │     ║
║  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘     ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  MEMORY ARCHITECTURE (7 Layers)        │                                              ║
║  ┌──────────────────────────────────────┼─────────────────────────────────────┐        ║
║  │ L7: Causal Graph (mythos-causal-graph, Rust)                              │        ║
║  │ L6: Episodic Memory (event + temporal index)                               │        ║
║  │ L5: Semantic Memory (memory-wiki + provenance)                             │        ║
║  │ L4: Procedural Memory (skill execution traces)                             │        ║
║  │ L3: Long-Term (MEMORY.md + Dreaming 3-phase, */3hr, 6 signals)            │        ║
║  │ L2: Daily Logs + JSONL Transcripts                                         │        ║
║  │ L1: Active Session Context Window                                          │        ║
║  │ Backend: mythos-vector-engine (HNSW) │ mythos-search-engine (Tantivy)     │        ║
║  │ Embed: mythos-embedding-runtime (GPU) │ Fallback: sqlite-vec + FTS5       │        ║
║  └───────────────────────────────────────────────────────────────────────────┘        ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  SECURITY (NemoClaw-class)             │                                              ║
║  ┌──────────────────────────────────────┼─────────────────────────────────────┐        ║
║  │ OpenShell OS-level sandbox │ YAML per-agent policy │ SkillSpector scan    │        ║
║  │ Crypto audit trail │ Privacy router │ Exec approval gates                  │        ║
║  │ Loopback bind │ TLS + Tailscale │ Device pairing + token rotation         │        ║
║  └───────────────────────────────────────────────────────────────────────────┘        ║
║                                          │                                             ║
║  ═══════════════════════════════════════╪══════════════════════════════════             ║
║  NATIVE CLIENTS (WebSocket nodes)      │                                              ║
║  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                                ║
║  │iOS App   │ │Android   │ │macOS App │ │Apple     │                                ║
║  │SwiftUI   │ │Compose   │ │Menu bar  │ │Watch     │                                ║
║  │WKWebView │ │CameraX   │ │Peekaboo  │ │Companion │                                ║
║  │HealthKit │ │SMS       │ │launchd   │ │          │                                ║
║  │PTT Voice │ │Location  │ │Sparkle   │ │          │                                ║
║  └──────────┘ └──────────┘ └──────────┘ └──────────┘                                ║
║                                                                                       ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝
```

---

> 🦞→🏛️ **THREE PARTS COMPLETE.**
>
> **Part I**: The complete architectural map — every directory, every file, every subsystem, every extension, every code path in the 885K-line codebase.
>
> **Part II**: The wire-level protocols — every TypeBox schema, every frame type, every handshake sequence, every Rust crate API with NAPI-RS bindings.
>
> **Part III**: The operational blueprint — production config, workspace layout, fleet SOUL files, Lobster workflows, cron registry, operator runbook, security hardening, Rust migration plan, and the 20 Laws.
>
> The Mythos-class agent is not software. It is an **architecture of cognition** — gateway-governed, multi-brained, Rust-accelerated, perpetually dreaming, provenance-rich, webhook-triggered, kernel-sandboxed, and locally sovereign.
>
> The lobster has titanium claws. The mythology has a foundation. 🦞⚡🏛️
