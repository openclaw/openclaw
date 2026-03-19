# Unified MABOS: Incorporating Paperclip + Hermes into OpenClaw-MABOS

**Date:** 2026-03-29
**Status:** Design
**Author:** Architecture session (Claude + operator)

## Context

Four repos form the MABOS ecosystem:

| Repo | Role | Core Strength |
|------|------|---------------|
| **openclaw-mabos** | BDI agent engine | 35 reasoning methods, TypeDB knowledge graphs, SBVR ontologies, 99 tools, ERP |
| **paperclip-mabos** | Orchestration platform | Budget enforcement, RBAC, multi-company isolation, 7 agent adapters, audit trail |
| **mabos-mission-control** | Operator dashboard | AI planning, task dispatch, knowledge capture, goal kanban, cognitive feed |
| **hermes-agent-mabos** | Autonomous agent runtime | Multi-provider model router, skill auto-creation, MoA ensemble, 6 terminal backends |

OpenClaw-MABOS is the core. Mission Control is already integrated via the gateway. This design adds the missing Paperclip and Hermes capabilities as **7 new modules** inside the MABOS extension, using the existing plugin SDK.

---

## Design Principles

1. **No rewrite** — every feature maps to an existing plugin SDK hook (`registerTool`, `registerService`, `registerHttpRoute`, `registerHook`, `registerProvider`)
2. **Graceful degradation** — every module works standalone; TypeDB down? Budget DB unavailable? The system continues with reduced functionality
3. **Config-driven activation** — each module has a feature flag in `MabosPluginConfig`; disabled by default until configured
4. **Agent-scoped isolation** — all state (budgets, sessions, skills) scoped to agent or company
5. **Zero new top-level dependencies** — new deps go in the extension `package.json`, not root

---

## Architecture Overview

```
extensions/mabos/extensions-mabos/src/
├── governance/          # Module 1: Budget, RBAC, audit, multi-company
├── model-router/        # Module 2: Multi-provider, fallback, MoA, prompt cache
├── execution-sandbox/   # Module 3: Docker, SSH, Modal terminal backends
├── skill-loop/          # Module 4: Autonomous skill creation, marketplace
├── session-intel/       # Module 5: FTS5 search, cross-session recall, user modeling
├── security/            # Module 6: Injection scanning, approval guards
├── tools/               # (existing) — 99 business tools
├── knowledge/           # (existing) — TypeDB integration
├── reasoning/           # (existing) — 35 reasoning methods
├── ontology/            # (existing) — SBVR engine
└── types/               # (existing) — shared types
```

UI enhancements (Module 7) go in the existing `ui/src/` tree.

---

## Module 1: Governance

**Source inspiration:** Paperclip's `server/src/services/budgets/`, `server/src/auth/`, `server/src/routes/costs/`

### Purpose

Atomic budget enforcement, role-based access control, immutable audit trail, and multi-company data isolation. Currently OpenClaw-MABOS has `financialToolGuardEnabled` and `stakeholderApprovalThresholdUsd` but no actual budget ledger, no RBAC, and no audit log.

### Files

```
governance/
├── index.ts              # Module registration (tools + hooks + routes + service)
├── types.ts              # Budget, Role, AuditEntry, Company types
├── budget-ledger.ts      # SQLite-backed budget tracking with atomic checkout
├── rbac.ts               # Role-permission matrix and policy engine
├── audit-log.ts          # Append-only audit trail (SQLite WAL)
├── company-scope.ts      # Multi-company data isolation middleware
├── hooks.ts              # Plugin hooks: before_tool_call, llm_output, agent_end
└── routes.ts             # HTTP routes: /mabos/governance/*
```

### Config Extension

```typescript
// Added to MabosPluginConfig
export interface GovernanceConfig {
  governanceEnabled?: boolean;              // Master switch (default: false)
  budget?: {
    enabled?: boolean;
    defaultDailyLimitUsd?: number;          // Per-agent daily spend cap
    defaultMonthlyLimitUsd?: number;        // Per-agent monthly cap
    hardCeilingUsd?: number;                // Absolute maximum per-action
    alertThresholdPercent?: number;          // Alert at N% of budget (default: 80)
    requireApprovalAboveUsd?: number;       // Human gate for expensive ops
  };
  rbac?: {
    enabled?: boolean;
    defaultRole?: "operator" | "agent" | "viewer" | "admin";
    policyPath?: string;                    // Path to custom RBAC policy YAML
  };
  audit?: {
    enabled?: boolean;
    retentionDays?: number;                 // Default: 90
    dbPath?: string;                        // Default: workspace/governance.db
  };
  multiCompany?: {
    enabled?: boolean;                      // Default: false (single-company mode)
  };
}
```

### Budget Ledger (SQLite)

```sql
-- governance.db
CREATE TABLE budget_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'monthly', 'project')),
  period_key TEXT NOT NULL,              -- '2026-03-29' or '2026-03' or project_id
  limit_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0, -- Pre-allocated for in-flight tasks
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, agent_id, period_type, period_key)
);

CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'llm_input', 'llm_output', 'tool_call', 'api_call', 'reservation', 'release'
  )),
  amount_usd REAL NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  metadata TEXT,                          -- JSON blob for event-specific data
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  company_id TEXT NOT NULL DEFAULT 'default',
  actor_type TEXT NOT NULL CHECK(actor_type IN ('agent', 'operator', 'system', 'hook')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,                   -- 'tool_call', 'budget_spend', 'config_change', etc.
  resource_type TEXT,                     -- 'task', 'agent', 'budget', 'config', etc.
  resource_id TEXT,
  detail TEXT,                            -- JSON blob
  outcome TEXT CHECK(outcome IN ('success', 'denied', 'error', 'pending'))
);

CREATE INDEX idx_budget_lookup ON budget_allocations(company_id, agent_id, period_type, period_key);
CREATE INDEX idx_cost_agent ON cost_events(company_id, agent_id, created_at);
CREATE INDEX idx_audit_time ON audit_log(company_id, timestamp);
```

### Atomic Budget Check (Reservation Pattern)

Inspired by Paperclip's atomic checkout — prevents double-spend when multiple agents act concurrently.

```typescript
// budget-ledger.ts
export class BudgetLedger {
  private db: Database;  // better-sqlite3

  /**
   * Atomically reserve funds before a tool call.
   * Returns reservation_id on success, throws BudgetExhaustedError on failure.
   */
  reserveBudget(params: {
    companyId: string;
    agentId: string;
    estimatedCostUsd: number;
    sessionId: string;
    toolName?: string;
  }): string {
    // Single transaction:
    // 1. Read current allocation for today + month
    // 2. Check (spent + reserved + estimated) <= limit for BOTH periods
    // 3. Insert reservation cost_event
    // 4. Increment reserved_usd on allocation
    // 5. Return reservation_id
    // All inside db.transaction() — atomic
  }

  /**
   * Settle a reservation after tool execution completes.
   * Converts reservation to actual spend (may differ from estimate).
   */
  settleReservation(reservationId: string, actualCostUsd: number): void {
    // Transaction:
    // 1. Remove reservation amount from reserved_usd
    // 2. Add actual amount to spent_usd
    // 3. Insert settlement cost_event
  }

  /**
   * Release a reservation that was never used (tool call cancelled/failed).
   */
  releaseReservation(reservationId: string): void;

  /** Get remaining budget for agent across all periods. */
  getRemainingBudget(companyId: string, agentId: string): BudgetStatus;
}
```

### Hook Wiring

```typescript
// hooks.ts — registered via api.on()

// 1. Before every tool call: reserve budget
api.on("before_tool_call", async (ctx) => {
  const estimate = estimateToolCost(ctx.toolName, ctx.args);
  if (estimate > 0) {
    ctx.meta.budgetReservationId = ledger.reserveBudget({
      companyId: resolveCompanyId(ctx),
      agentId: ctx.agentId,
      estimatedCostUsd: estimate,
      sessionId: ctx.sessionId,
      toolName: ctx.toolName,
    });
  }
  // RBAC check
  if (!rbac.isAllowed(ctx.actorRole, ctx.toolName, ctx.args)) {
    throw new PermissionDeniedError(ctx.actorRole, ctx.toolName);
  }
  // Audit
  audit.log({ action: "tool_call", ...ctx });
});

// 2. After every tool call: settle budget
api.on("after_tool_call", async (ctx) => {
  if (ctx.meta.budgetReservationId) {
    ledger.settleReservation(ctx.meta.budgetReservationId, ctx.actualCost ?? 0);
  }
});

// 3. After LLM output: track token costs
api.on("llm_output", async (ctx) => {
  const cost = calculateTokenCost(ctx.model, ctx.inputTokens, ctx.outputTokens);
  ledger.recordDirectCost({
    companyId: resolveCompanyId(ctx),
    agentId: ctx.agentId,
    eventType: "llm_output",
    amountUsd: cost,
    model: ctx.model,
    inputTokens: ctx.inputTokens,
    outputTokens: ctx.outputTokens,
  });
});
```

### RBAC Policy

```yaml
# governance-policy.yaml (loaded from rbac.policyPath)
roles:
  admin:
    permissions: ["*"]
  operator:
    permissions:
      - "tool:*"
      - "budget:view"
      - "config:read"
      - "agent:manage"
    deny:
      - "tool:dangerous_delete"
      - "config:write:governance"
  agent:
    permissions:
      - "tool:read_*"
      - "tool:write_*"
      - "tool:reason_*"
      - "tool:bdi_*"
      - "budget:view:self"
    deny:
      - "tool:shopify_delete_*"
      - "tool:send_payment"
    budgetLimit:
      perAction: 5.00
      daily: 50.00
  viewer:
    permissions:
      - "tool:read_*"
      - "budget:view"
      - "audit:view"
```

### HTTP Routes

```
GET  /mabos/governance/budget/:agentId        → Current budget status
GET  /mabos/governance/budget/summary          → All agents budget overview
POST /mabos/governance/budget/allocate         → Create/update allocation
GET  /mabos/governance/costs?from=&to=&agent=  → Cost event history
GET  /mabos/governance/audit?from=&to=&action= → Audit log query
GET  /mabos/governance/roles                   → RBAC role definitions
POST /mabos/governance/roles/:agentId          → Assign role to agent
```

### Tools Registered

```
budget_status     — Agent checks own remaining budget
budget_request    — Agent requests budget increase (triggers approval)
audit_query       — Query audit trail (admin/operator only)
```

---

## Module 2: Model Router

**Source inspiration:** Hermes's `run_agent.py` provider system, `model_tools.py`, `tools/mixture_of_agents_tool.py`

### Purpose

Multi-provider model registry with instant switching, automatic fallback chains, prompt caching optimization, and Mixture-of-Agents ensemble reasoning. Currently OpenClaw-MABOS is coupled to the pi-agent-core model resolution.

### Files

```
model-router/
├── index.ts              # Module registration
├── types.ts              # Provider, ModelSpec, FallbackChain, MoAConfig
├── registry.ts           # Provider catalog (Anthropic, OpenAI, OpenRouter, HF, etc.)
├── resolver.ts           # Model resolution with fallback chains
├── cost-estimator.ts     # Per-model token pricing table
├── prompt-cache.ts       # Anthropic prompt caching optimization
├── moa.ts                # Mixture-of-Agents ensemble reasoning
└── hooks.ts              # before_model_resolve hook
```

### Config Extension

```typescript
export interface ModelRouterConfig {
  modelRouterEnabled?: boolean;            // Default: false
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;                // 'anthropic' | 'openai' | 'openrouter' | etc.
  fallbackChain?: string[];                // ['anthropic/claude-opus-4-6', 'openai/gpt-4.1', ...]
  promptCaching?: {
    enabled?: boolean;                     // Default: true for Anthropic
    systemPromptCacheBreakpoints?: number; // Num cache control points
  };
  moa?: {
    enabled?: boolean;                     // Default: false
    referenceModels?: string[];            // Models for reference layer
    aggregatorModel?: string;              // Model for synthesis
    maxParallelCalls?: number;             // Default: 4
  };
  costTracking?: {
    enabled?: boolean;
    pricingOverrides?: Record<string, { inputPer1k: number; outputPer1k: number }>;
  };
}
```

### Provider Registry

```typescript
// registry.ts
export interface ProviderConfig {
  type: "anthropic" | "openai" | "openrouter" | "huggingface" | "custom";
  baseUrl?: string;
  apiKeyEnv: string;                       // Env var name holding the key
  models?: ModelSpec[];                    // Override model catalog
}

export interface ModelSpec {
  id: string;                              // 'claude-opus-4-6'
  contextWindow: number;                   // 200000
  maxOutput: number;                       // 128000
  inputPricePer1kTokens: number;           // 0.015
  outputPricePer1kTokens: number;          // 0.075
  supportsPromptCaching?: boolean;
  supportsExtendedThinking?: boolean;
  supportsVision?: boolean;
}

// Built-in catalog (updated periodically):
const BUILTIN_MODELS: Record<string, ModelSpec[]> = {
  anthropic: [
    { id: "claude-opus-4-6", contextWindow: 200000, maxOutput: 128000,
      inputPricePer1kTokens: 0.015, outputPricePer1kTokens: 0.075,
      supportsPromptCaching: true, supportsExtendedThinking: true, supportsVision: true },
    { id: "claude-sonnet-4-6", contextWindow: 200000, maxOutput: 64000,
      inputPricePer1kTokens: 0.003, outputPricePer1kTokens: 0.015,
      supportsPromptCaching: true, supportsExtendedThinking: true, supportsVision: true },
    // ...
  ],
  openai: [ /* gpt-4.1, o3, o4-mini, ... */ ],
  openrouter: [ /* 200+ models via API discovery */ ],
};
```

### Fallback Chain Resolution

```typescript
// resolver.ts
export class ModelResolver {
  /**
   * Resolve model with fallback. Called from before_model_resolve hook.
   *
   * Resolution order:
   * 1. Explicit model from agent config
   * 2. Task-appropriate model (cheap for simple, expensive for complex)
   * 3. Fallback chain on provider failure
   */
  async resolve(request: ModelRequest): Promise<ResolvedModel> {
    for (const modelId of this.buildResolutionChain(request)) {
      const provider = this.getProvider(modelId);
      if (!provider) continue;

      const apiKey = process.env[provider.apiKeyEnv];
      if (!apiKey) continue;

      // Health check (cached for 60s)
      if (await this.isHealthy(provider, modelId)) {
        return {
          modelId,
          provider,
          spec: this.getSpec(modelId),
          apiKey,
        };
      }
    }
    throw new NoAvailableModelError(request);
  }
}
```

### Mixture-of-Agents (MoA)

```typescript
// moa.ts — Registered as tool: reason_ensemble
export async function mixtureOfAgents(params: {
  problem: string;
  referenceModels?: string[];    // Default: 4 diverse frontier models
  aggregatorModel?: string;      // Default: claude-opus-4-6
}): Promise<MoAResult> {
  // Phase 1: Reference layer — parallel calls to diverse models
  const referenceResponses = await Promise.all(
    referenceModels.map(model =>
      callModel(model, buildReferencePrompt(params.problem))
    )
  );

  // Phase 2: Aggregator — synthesize into final answer
  const aggregated = await callModel(aggregatorModel, buildAggregatorPrompt(
    params.problem,
    referenceResponses,
  ));

  return {
    finalAnswer: aggregated.content,
    referenceResponses: referenceResponses.map(r => ({
      model: r.model,
      response: r.content,
    })),
    agreement: calculateAgreementScore(referenceResponses),
    totalCost: sumCosts(referenceResponses) + aggregated.cost,
  };
}
```

### Hook Wiring

```typescript
// hooks.ts
api.on("before_model_resolve", async (ctx) => {
  if (!config.modelRouterEnabled) return;

  const resolved = await resolver.resolve({
    preferredModel: ctx.requestedModel,
    taskComplexity: ctx.taskHint,
    budgetRemaining: ledger?.getRemainingBudget(ctx.companyId, ctx.agentId),
  });

  ctx.model = resolved.modelId;
  ctx.provider = resolved.provider;
  ctx.apiKey = resolved.apiKey;

  // Apply prompt caching if supported
  if (config.promptCaching?.enabled && resolved.spec.supportsPromptCaching) {
    ctx.systemPromptCacheControl = true;
  }
});
```

### Tools Registered

```
model_switch      — Switch model mid-conversation (slash command: /model)
model_list        — List available models with pricing
reason_ensemble   — MoA multi-model reasoning for hard problems
model_cost        — Estimate cost for a given prompt + model
```

---

## Module 3: Execution Sandbox

**Source inspiration:** Hermes's `tools/terminal_tool.py` (6 backends), Paperclip's `packages/adapters/`

### Purpose

Isolated terminal execution backends beyond the local shell. Critical for running untrusted agent-generated code safely and for remote execution on cloud infrastructure.

### Files

```
execution-sandbox/
├── index.ts              # Module registration
├── types.ts              # SandboxBackend, ExecutionResult, SandboxConfig
├── manager.ts            # Backend lifecycle manager
├── backends/
│   ├── local.ts          # Pass-through to host shell (existing behavior)
│   ├── docker.ts         # Docker container execution
│   ├── ssh.ts            # Remote host via SSH
│   └── modal.ts          # Modal.com serverless sandbox
├── hooks.ts              # Terminal tool interception
└── routes.ts             # /mabos/sandbox/* management routes
```

### Config Extension

```typescript
export interface ExecutionSandboxConfig {
  sandboxEnabled?: boolean;                // Default: false (use local)
  defaultBackend?: "local" | "docker" | "ssh" | "modal";
  docker?: {
    image?: string;                        // Default: 'mabos-sandbox:latest'
    memoryLimitMb?: number;                // Default: 512
    cpuLimit?: number;                     // Default: 1.0
    networkMode?: "none" | "bridge" | "host";  // Default: 'bridge'
    timeoutSeconds?: number;               // Default: 300
    mountWorkspace?: boolean;              // Default: true (read-only)
    persistContainer?: boolean;            // Default: false (destroy after task)
  };
  ssh?: {
    host?: string;
    port?: number;
    user?: string;
    keyPath?: string;
    workingDir?: string;
  };
  modal?: {
    appName?: string;
    timeoutSeconds?: number;
    gpu?: string;                          // e.g., 'T4', 'A100'
  };
  perAgent?: Record<string, {              // Per-agent backend override
    backend: "local" | "docker" | "ssh" | "modal";
  }>;
}
```

### Backend Interface

```typescript
// types.ts
export interface SandboxBackend {
  readonly name: string;

  /** Initialize the backend (start container, open SSH, etc.) */
  init(taskId: string): Promise<void>;

  /** Execute a command, return stdout/stderr/exitCode */
  exec(command: string, opts?: ExecOpts): Promise<ExecutionResult>;

  /** Upload a file into the sandbox */
  uploadFile?(localPath: string, remotePath: string): Promise<void>;

  /** Download a file from the sandbox */
  downloadFile?(remotePath: string, localPath: string): Promise<void>;

  /** Cleanup resources */
  destroy(): Promise<void>;

  /** Health check */
  isHealthy(): Promise<boolean>;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;          // True if output exceeded limit
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;     // Default: 1MB
}
```

### Docker Backend

```typescript
// backends/docker.ts
export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  private containerId: string | null = null;

  async init(taskId: string): Promise<void> {
    const { image, memoryLimitMb, cpuLimit, networkMode, mountWorkspace } = this.config;

    const args = [
      "docker", "run", "-d",
      "--name", `mabos-sandbox-${taskId}`,
      "--memory", `${memoryLimitMb}m`,
      "--cpus", String(cpuLimit),
      "--network", networkMode,
      "--pids-limit", "256",
      "--read-only",                      // Read-only root filesystem
      "--tmpfs", "/tmp:rw,noexec,size=100m",
    ];

    if (mountWorkspace) {
      args.push("-v", `${this.workspaceDir}:/workspace:ro`);
    }

    args.push(image, "sleep", "infinity");

    const result = await execLocal(args.join(" "));
    this.containerId = result.stdout.trim();
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecutionResult> {
    const execArgs = ["docker", "exec"];
    if (opts?.cwd) execArgs.push("-w", opts.cwd);
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        execArgs.push("-e", `${k}=${v}`);
      }
    }
    execArgs.push(this.containerId!, "sh", "-c", command);

    return execWithTimeout(execArgs.join(" "), opts?.timeoutMs ?? this.config.timeoutSeconds * 1000);
  }

  async destroy(): Promise<void> {
    if (this.containerId) {
      await execLocal(`docker rm -f ${this.containerId}`);
      this.containerId = null;
    }
  }
}
```

### Hook Wiring

The sandbox intercepts terminal tool calls when `sandboxEnabled` is true:

```typescript
// hooks.ts
api.on("before_tool_call", async (ctx) => {
  if (ctx.toolName !== "terminal" && ctx.toolName !== "execute_command") return;
  if (!config.sandboxEnabled) return;

  const backend = resolveBackend(ctx.agentId, config);
  if (backend === "local") return; // Pass through

  // Replace tool execution with sandbox execution
  const sandbox = await manager.getOrCreate(ctx.taskId, backend);
  ctx.override = async () => {
    const result = await sandbox.exec(ctx.args.command, {
      cwd: ctx.args.cwd,
      timeoutMs: ctx.args.timeout,
    });
    return textResult(formatExecResult(result));
  };
});
```

---

## Module 4: Skill Loop

**Source inspiration:** Hermes's `tools/skills_tool.py`, `tools/skill_manager_tool.py`, `optional-skills/`

### Purpose

Autonomous skill creation from agent experience, a local skill registry, and marketplace integration. Currently MABOS agents learn via case-based reasoning in TypeDB but cannot create reusable executable skills.

### Files

```
skill-loop/
├── index.ts              # Module registration
├── types.ts              # Skill, SkillManifest, SkillRegistry
├── registry.ts           # Local skill discovery and indexing
├── creator.ts            # Autonomous skill creation from task experience
├── marketplace.ts        # Browse/install from skill hubs
├── injector.ts           # Inject relevant skills into agent system prompt
├── nudge.ts              # Periodic nudge to create skills after complex tasks
└── routes.ts             # /mabos/skills/* management routes
```

### Config Extension

```typescript
export interface SkillLoopConfig {
  skillLoopEnabled?: boolean;              // Default: false
  skillPaths?: string[];                   // Default: ['~/.openclaw/skills', workspace/skills]
  creationNudgeInterval?: number;          // Sessions between nudges (default: 10)
  autoInstall?: boolean;                   // Auto-install suggested skills (default: false)
  marketplace?: {
    enabled?: boolean;
    sources?: Array<{
      name: string;
      type: "github" | "clawhub" | "local";
      url?: string;
    }>;
  };
  maxSkillsInPrompt?: number;              // Default: 5 (injected per session)
}
```

### Skill Format

Compatible with Hermes format for cross-ecosystem portability:

```
my-skill/
├── SKILL.md              # Main skill content (markdown with executable code blocks)
├── manifest.json         # Metadata: name, description, version, tags, author, tools_required
├── references/           # Reference documents
├── templates/            # Reusable templates
├── scripts/              # Helper scripts
└── tests/                # Skill validation tests
```

```json
// manifest.json
{
  "name": "shopify-product-launch",
  "version": "1.0.0",
  "description": "End-to-end product launch workflow for Shopify stores",
  "author": "mabos-cmo",
  "tags": ["shopify", "marketing", "launch"],
  "tools_required": ["shopify_create_product", "shopify_create_collection", "send_email"],
  "applicable_roles": ["CMO", "COO"],
  "created_from_session": "session-abc-123",
  "created_at": "2026-03-29T10:00:00Z",
  "confidence": 0.85
}
```

### Autonomous Skill Creation

```typescript
// creator.ts
export class SkillCreator {
  /**
   * Analyze a completed task session and propose a reusable skill.
   * Called by the nudge system after complex multi-tool sessions.
   */
  async proposeSkill(params: {
    sessionHistory: Message[];
    taskDescription: string;
    toolsUsed: string[];
    outcome: "success" | "partial" | "failure";
    agentId: string;
  }): Promise<SkillProposal | null> {
    // 1. Filter: only propose from successful multi-step sessions
    if (params.outcome === "failure") return null;
    if (params.toolsUsed.length < 3) return null;

    // 2. Check: is this pattern already covered by an existing skill?
    const existingSkills = await this.registry.search(params.taskDescription);
    if (existingSkills.some(s => s.similarity > 0.85)) return null;

    // 3. Extract: distill session into reusable steps
    const proposal = await this.distillSession(params);

    // 4. Return proposal for human approval (or auto-create if configured)
    return proposal;
  }

  /**
   * Distill a session into a skill by extracting the tool-call DAG,
   * generalizing parameters, and writing SKILL.md.
   */
  private async distillSession(params: {
    sessionHistory: Message[];
    taskDescription: string;
    toolsUsed: string[];
  }): Promise<SkillProposal> {
    // Extract ordered tool calls
    const toolCalls = extractToolCallSequence(params.sessionHistory);

    // Generalize: replace specific IDs/values with {{parameter}} placeholders
    const generalized = generalizeToolCalls(toolCalls);

    // Generate SKILL.md
    const skillMd = renderSkillMarkdown({
      description: params.taskDescription,
      steps: generalized,
      toolsRequired: params.toolsUsed,
    });

    return {
      name: slugify(params.taskDescription),
      skillMd,
      manifest: { /* ... */ },
      confidence: calculateConfidence(params),
    };
  }
}
```

### Nudge System

```typescript
// nudge.ts
export class SkillNudge {
  private sessionsSinceLastNudge = 0;

  /**
   * Called at session_end hook.
   * Tracks sessions and periodically suggests skill creation.
   */
  async onSessionEnd(ctx: SessionEndContext): Promise<void> {
    this.sessionsSinceLastNudge++;

    if (this.sessionsSinceLastNudge < config.creationNudgeInterval) return;
    this.sessionsSinceLastNudge = 0;

    const proposal = await creator.proposeSkill({
      sessionHistory: ctx.messages,
      taskDescription: ctx.taskDescription,
      toolsUsed: ctx.toolsUsed,
      outcome: ctx.outcome,
      agentId: ctx.agentId,
    });

    if (proposal) {
      // Surface to operator via Mission Control decision queue
      await emitDecision({
        type: "skill_creation",
        title: `Create skill: ${proposal.name}`,
        description: `Agent completed a reusable ${proposal.manifest.tags.join("/")} workflow. Save as skill?`,
        options: [
          { id: "approve", label: "Create Skill", impact: "Skill saved to local registry" },
          { id: "edit", label: "Edit & Create", impact: "Open skill editor" },
          { id: "skip", label: "Skip", impact: "No skill created" },
        ],
        recommendation: "approve",
      });
    }
  }
}
```

### Prompt Injection

```typescript
// injector.ts — Called from before_prompt_build hook
export async function injectRelevantSkills(ctx: PromptBuildContext): Promise<void> {
  if (!config.skillLoopEnabled) return;

  // Search skills relevant to current task/conversation
  const relevant = await registry.searchByContext({
    taskDescription: ctx.taskHint,
    agentRole: ctx.agentRole,
    recentTools: ctx.recentToolNames,
    limit: config.maxSkillsInPrompt,
  });

  if (relevant.length === 0) return;

  // Inject as user messages (preserves Anthropic prompt cache on system prompt)
  for (const skill of relevant) {
    ctx.appendUserMessage({
      role: "user",
      content: `[SKILL: ${skill.name}]\n${skill.content}`,
      meta: { skillInjection: true },
    });
  }
}
```

### Tools Registered

```
skill_create      — Create a new skill from description
skill_search      — Search local + marketplace skills
skill_install     — Install skill from marketplace
skill_list        — List installed skills
skill_run         — Execute a named skill
```

---

## Module 5: Session Intelligence

**Source inspiration:** Hermes's `hermes_state.py` (FTS5), `tools/session_search.py`, `honcho_integration/`

### Purpose

Full-text search across past sessions, cross-session knowledge recall with LLM summarization, and dialectic user modeling. Currently OpenClaw has per-agent session logs but no search or profile building.

### Files

```
session-intel/
├── index.ts              # Module registration
├── types.ts              # SessionIndex, UserProfile, RecallResult
├── session-index.ts      # SQLite FTS5 index over session history
├── recall.ts             # Cross-session knowledge retrieval + summarization
├── user-model.ts         # Dialectic user profile builder
├── hooks.ts              # session_end, before_prompt_build hooks
└── routes.ts             # /mabos/sessions/* search routes
```

### Config Extension

```typescript
export interface SessionIntelConfig {
  sessionIntelEnabled?: boolean;           // Default: false
  fts?: {
    enabled?: boolean;                     // Default: true
    dbPath?: string;                       // Default: workspace/session-index.db
    indexOnSessionEnd?: boolean;           // Default: true
  };
  recall?: {
    enabled?: boolean;                     // Default: true
    maxRecallResults?: number;             // Default: 5
    summarizeResults?: boolean;            // Default: true (LLM summary)
  };
  userModel?: {
    enabled?: boolean;                     // Default: false
    profilePath?: string;                  // Default: workspace/USER.md
    updateInterval?: number;              // Sessions between profile updates (default: 5)
  };
}
```

### FTS5 Session Index

```sql
-- session-index.db
CREATE TABLE indexed_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT 'default',
  source TEXT,                             -- 'cli', 'telegram', 'web', etc.
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  title TEXT,
  summary TEXT                             -- LLM-generated session summary
);

CREATE TABLE indexed_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES indexed_sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_name TEXT,                          -- For tool_call messages
  timestamp REAL NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=indexed_messages,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER messages_ai AFTER INSERT ON indexed_messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
```

### Cross-Session Recall

```typescript
// recall.ts
export class SessionRecall {
  /**
   * Search past sessions for relevant knowledge.
   * Returns ranked results with optional LLM summarization.
   */
  async recall(params: {
    query: string;
    agentId?: string;
    companyId?: string;
    limit?: number;
    summarize?: boolean;
  }): Promise<RecallResult[]> {
    // 1. FTS5 search across indexed_messages
    const ftsResults = await this.db.all(`
      SELECT m.content, m.role, m.tool_name, m.timestamp,
             s.title, s.agent_id, s.source,
             rank AS relevance
      FROM messages_fts f
      JOIN indexed_messages m ON m.id = f.rowid
      JOIN indexed_sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?
        AND (? IS NULL OR s.agent_id = ?)
        AND (? IS NULL OR s.company_id = ?)
      ORDER BY rank
      LIMIT ?
    `, [query, agentId, agentId, companyId, companyId, limit]);

    // 2. Group by session
    const grouped = groupBySession(ftsResults);

    // 3. Optionally summarize each session cluster
    if (params.summarize) {
      return Promise.all(grouped.map(async (group) => ({
        ...group,
        summary: await this.summarizeCluster(query, group.messages),
      })));
    }

    return grouped;
  }

  /**
   * LLM-powered summarization of search results in context of the query.
   */
  private async summarizeCluster(query: string, messages: IndexedMessage[]): Promise<string> {
    const prompt = `Given this search query: "${query}"
Summarize the relevant information from these past conversation excerpts:

${messages.map(m => `[${m.role}]: ${m.content.slice(0, 500)}`).join("\n")}

Provide a concise, actionable summary (2-3 sentences).`;

    return callModel(config.cheapModel ?? "claude-haiku-4-5", prompt);
  }
}
```

### User Modeling (Honcho-inspired)

```typescript
// user-model.ts
export class UserModel {
  private profilePath: string;

  /**
   * Dialectic profile builder.
   * After N sessions, analyzes interactions to build/update user profile.
   */
  async updateProfile(recentSessions: SessionSummary[]): Promise<void> {
    const currentProfile = await this.readProfile();

    const prompt = `You are building a profile of the user based on their interactions.

Current profile:
${currentProfile || "(empty — first time)"}

Recent session summaries:
${recentSessions.map(s => `- ${s.title}: ${s.summary}`).join("\n")}

Update the profile with new observations about:
- Communication style (terse vs. detailed, technical level)
- Domain expertise (what they know well, what they're learning)
- Workflow preferences (how they like tasks done)
- Decision patterns (risk tolerance, speed vs. quality)
- Recurring topics/interests

Return the updated profile in markdown format.
Do NOT include speculative or judgmental content.`;

    const updated = await callModel("claude-sonnet-4-6", prompt);
    await writeFile(this.profilePath, updated);
  }

  /**
   * Inject user profile into agent system prompt for personalization.
   */
  async injectProfile(ctx: PromptBuildContext): Promise<void> {
    const profile = await this.readProfile();
    if (!profile) return;

    ctx.appendSystemSection("user-profile", `
## User Profile
${profile}
Use this profile to tailor responses and work style.`);
  }
}
```

### Tools Registered

```
session_search    — Search past sessions by keyword/topic
session_recall    — Retrieve and summarize relevant past context
user_profile      — View/update user profile (operator)
```

---

## Module 6: Security Hardening

**Source inspiration:** Hermes's memory injection scanner, `tools/skills_guard.py`, supply chain audit CI

### Purpose

Proactive security for agent-generated content: memory/prompt injection detection, tool approval guards for destructive operations, and input/output sanitization.

### Files

```
security/
├── index.ts              # Module registration
├── types.ts              # ThreatLevel, ScanResult, ApprovalRequest
├── injection-scanner.ts  # Prompt injection + exfiltration detection
├── tool-guard.ts         # Approval gate for dangerous tool calls
├── sanitizer.ts          # Input/output sanitization
├── url-validator.ts      # SSRF prevention for URL-accepting tools
└── hooks.ts              # before_tool_call, memory hooks
```

### Config Extension

```typescript
export interface SecurityConfig {
  securityEnabled?: boolean;               // Default: true (on by default!)
  injectionScanning?: {
    enabled?: boolean;                     // Default: true
    scanMemoryWrites?: boolean;            // Default: true
    scanToolInputs?: boolean;              // Default: true
    scanExternalContent?: boolean;         // Default: true
    blockOnDetection?: boolean;            // Default: true (vs. warn-only)
  };
  toolGuard?: {
    enabled?: boolean;                     // Default: true
    dangerousTools?: string[];             // Tools requiring approval
    autoApproveForRoles?: string[];        // Roles that bypass approval (e.g., 'admin')
    approvalTimeoutSeconds?: number;       // Default: 300
  };
  ssrf?: {
    enabled?: boolean;                     // Default: true
    blockedCidrs?: string[];              // Private/internal CIDRs
    allowedDomains?: string[];            // Explicit allowlist
  };
}
```

### Injection Scanner

```typescript
// injection-scanner.ts
export class InjectionScanner {
  private readonly patterns: ScanPattern[] = [
    // Prompt injection attempts
    { name: "role_override", regex: /\b(you are|act as|ignore previous|disregard|forget)\b.*\b(instructions|rules|system)\b/i,
      threat: "high" },
    { name: "delimiter_escape", regex: /(<\/?system>|<\|im_start\|>|<\|im_end\|>|\[INST\]|\[\/INST\])/i,
      threat: "critical" },
    { name: "invisible_unicode", regex: /[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/,
      threat: "medium" },

    // Exfiltration attempts
    { name: "curl_exfil", regex: /\b(curl|wget|fetch|axios)\b.*\b(memory|credentials|api.?key|token|secret)\b/i,
      threat: "critical" },
    { name: "base64_exfil", regex: /\b(btoa|atob|base64)\b.*\b(memory|key|secret|token)\b/i,
      threat: "high" },
    { name: "dns_exfil", regex: /\b(dig|nslookup|host)\b.*\.(burp|oast|interact|dnsbin)\./i,
      threat: "critical" },

    // Data extraction
    { name: "env_dump", regex: /\b(process\.env|os\.environ|\$ENV|printenv)\b/i,
      threat: "medium" },
    { name: "file_exfil", regex: /\b(\/etc\/passwd|\/etc\/shadow|\.ssh\/|\.aws\/|\.env)\b/,
      threat: "high" },
  ];

  /**
   * Scan text for injection/exfiltration patterns.
   */
  scan(text: string, context: ScanContext): ScanResult {
    const findings: ScanFinding[] = [];

    for (const pattern of this.patterns) {
      const match = pattern.regex.exec(text);
      if (match) {
        findings.push({
          pattern: pattern.name,
          threat: pattern.threat,
          match: match[0],
          position: match.index,
          context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
        });
      }
    }

    return {
      clean: findings.length === 0,
      findings,
      highestThreat: findings.reduce((max, f) =>
        THREAT_ORDER[f.threat] > THREAT_ORDER[max] ? f.threat : max,
        "none" as ThreatLevel,
      ),
    };
  }
}
```

### Tool Approval Guard

```typescript
// tool-guard.ts
const DEFAULT_DANGEROUS_TOOLS = [
  "execute_command",           // Arbitrary shell execution
  "shopify_delete_product",    // Destructive business operation
  "shopify_delete_collection",
  "send_payment",             // Financial action
  "send_email",               // External communication
  "twilio_send_sms",          // External communication
  "cloudflare_delete_*",      // Infrastructure destruction
  "godaddy_delete_*",         // Domain destruction
];

export class ToolGuard {
  /**
   * Check if a tool call requires human approval.
   * Returns null if approved, or ApprovalRequest if gate needed.
   */
  async checkApproval(ctx: ToolCallContext): Promise<ApprovalRequest | null> {
    if (!this.isDangerous(ctx.toolName)) return null;
    if (this.isAutoApproved(ctx.actorRole)) return null;

    // Check if pre-approved in current session
    if (ctx.session.approvedTools?.includes(ctx.toolName)) return null;

    return {
      id: generatePrefixedId("approval"),
      toolName: ctx.toolName,
      args: this.redactSensitiveArgs(ctx.args),
      agentId: ctx.agentId,
      reason: `Tool "${ctx.toolName}" is classified as dangerous and requires operator approval.`,
      expiresAt: Date.now() + (config.approvalTimeoutSeconds * 1000),
    };
  }
}
```

### Hook Wiring

```typescript
// hooks.ts

// Scan all tool inputs for injection
api.on("before_tool_call", async (ctx) => {
  if (!config.injectionScanning?.scanToolInputs) return;

  const argsText = JSON.stringify(ctx.args);
  const result = scanner.scan(argsText, { source: "tool_input", tool: ctx.toolName });

  if (!result.clean && config.injectionScanning.blockOnDetection) {
    audit.log({
      action: "injection_blocked",
      detail: JSON.stringify(result.findings),
      agentId: ctx.agentId,
    });
    throw new SecurityBlockError(`Injection detected in ${ctx.toolName} input`, result);
  }
});

// Tool approval gate
api.on("before_tool_call", async (ctx) => {
  const approval = await guard.checkApproval(ctx);
  if (!approval) return;

  // Emit to Mission Control decision queue
  const decision = await waitForApproval(approval);
  if (decision === "denied") {
    throw new ApprovalDeniedError(approval);
  }
});

// Scan external content before injection into memory/context
api.on("before_message_write", async (ctx) => {
  if (!config.injectionScanning?.scanExternalContent) return;
  if (ctx.source !== "external") return;

  const result = scanner.scan(ctx.content, { source: "external_content" });
  if (!result.clean) {
    ctx.content = sanitizer.neutralize(ctx.content, result.findings);
  }
});
```

---

## Module 7: UI System Enhancements

**Source inspiration:** Paperclip's 77+ Radix UI components, command palette, Hermes's skin engine

### Purpose

Upgrade the MABOS dashboard from basic React components to a polished production UI with a command palette, governance dashboards, skill marketplace, and theming.

### Files (additions to existing `ui/src/`)

```
ui/src/
├── components/
│   ├── governance/              # NEW
│   │   ├── BudgetDashboard.tsx  # Budget overview with charts
│   │   ├── BudgetGauge.tsx      # Per-agent budget meter
│   │   ├── CostTimeline.tsx     # Cost events over time
│   │   ├── AuditLog.tsx         # Searchable audit trail
│   │   └── RoleManager.tsx      # RBAC role assignment
│   ├── skills/                  # NEW
│   │   ├── SkillMarketplace.tsx # Browse/install skills
│   │   ├── SkillEditor.tsx      # Edit SKILL.md with preview
│   │   ├── SkillCard.tsx        # Skill list item
│   │   └── SkillCreationReview.tsx  # Review auto-created skills
│   ├── sessions/                # NEW
│   │   ├── SessionSearch.tsx    # FTS5 search interface
│   │   ├── RecallPanel.tsx      # Cross-session recall results
│   │   └── UserProfileView.tsx  # User model display
│   ├── security/                # NEW
│   │   ├── SecurityDashboard.tsx  # Threat overview
│   │   ├── ApprovalQueue.tsx    # Pending tool approvals
│   │   └── ScanLog.tsx          # Injection scan history
│   ├── command-palette/         # NEW
│   │   └── CommandPalette.tsx   # Cmd+K global command palette
│   ├── models/                  # NEW
│   │   ├── ModelSwitcher.tsx    # Model selection dropdown
│   │   └── MoAResultView.tsx    # MoA ensemble result display
│   └── layout/
│       ├── Sidebar.tsx          # MODIFIED — add governance, skills, security nav
│       └── MobileNav.tsx        # MODIFIED — add new nav items
├── pages/
│   ├── GovernancePage.tsx       # NEW — budget + audit + RBAC
│   ├── SkillsPage.tsx           # NEW — marketplace + local skills
│   ├── SessionsPage.tsx         # NEW — search + recall
│   └── SecurityPage.tsx         # NEW — threat dashboard + approvals
└── hooks/
    ├── useGovernance.ts         # NEW — budget/audit API hooks
    ├── useSkills.ts             # NEW — skill CRUD hooks
    ├── useSessionSearch.ts      # NEW — FTS search hook
    └── useSecurity.ts           # NEW — security status hooks
```

### Command Palette (Cmd+K)

```typescript
// command-palette/CommandPalette.tsx
type PaletteCommand = {
  id: string;
  label: string;
  shortcut?: string;
  icon?: ReactNode;
  section: "navigation" | "agent" | "tool" | "model" | "skill";
  action: () => void;
};

const COMMANDS: PaletteCommand[] = [
  // Navigation
  { id: "nav-dashboard", label: "Go to Dashboard", shortcut: "G D", section: "navigation", ... },
  { id: "nav-agents", label: "Go to Agents", shortcut: "G A", section: "navigation", ... },
  { id: "nav-governance", label: "Go to Governance", shortcut: "G B", section: "navigation", ... },
  { id: "nav-skills", label: "Go to Skills", shortcut: "G S", section: "navigation", ... },
  { id: "nav-security", label: "Go to Security", shortcut: "G X", section: "navigation", ... },

  // Agent actions
  { id: "agent-bdi-cycle", label: "Trigger BDI Cycle", section: "agent", ... },
  { id: "agent-switch-model", label: "Switch Agent Model", section: "model", ... },

  // Tools
  { id: "tool-session-search", label: "Search Past Sessions", shortcut: "/", section: "tool", ... },
  { id: "tool-skill-create", label: "Create New Skill", section: "skill", ... },

  // Model
  { id: "model-moa", label: "Run MoA Ensemble", section: "model", ... },
];
```

### Budget Dashboard

```typescript
// governance/BudgetDashboard.tsx
export function BudgetDashboard() {
  const { budgets, costs, isLoading } = useGovernance();

  return (
    <div className="grid grid-cols-3 gap-4">
      {/* Per-agent budget gauges */}
      {budgets.map(b => (
        <BudgetGauge
          key={b.agentId}
          agentId={b.agentId}
          spent={b.spentUsd}
          limit={b.limitUsd}
          reserved={b.reservedUsd}
          alertThreshold={0.8}
        />
      ))}

      {/* Cost timeline chart */}
      <CostTimeline costs={costs} className="col-span-3" />

      {/* Audit log (searchable) */}
      <AuditLog className="col-span-3" />
    </div>
  );
}
```

---

## Registration: How It All Wires Together

All 7 modules register through the existing MABOS `index.ts` entry point:

```typescript
// extensions/mabos/extensions-mabos/index.ts (additions)

import { registerGovernance } from "./src/governance/index.js";
import { registerModelRouter } from "./src/model-router/index.js";
import { registerExecutionSandbox } from "./src/execution-sandbox/index.js";
import { registerSkillLoop } from "./src/skill-loop/index.js";
import { registerSessionIntel } from "./src/session-intel/index.js";
import { registerSecurity } from "./src/security/index.js";

export default async function activate(api: OpenClawPluginApi) {
  const config = getPluginConfig(api);

  // Existing MABOS tool registration (99 tools)...

  // === New modules ===

  // Module 1: Governance (budget, RBAC, audit)
  if (config.governanceEnabled) {
    await registerGovernance(api, config);
  }

  // Module 2: Model Router (multi-provider, fallback, MoA)
  if (config.modelRouterEnabled) {
    await registerModelRouter(api, config);
  }

  // Module 3: Execution Sandbox (Docker, SSH, Modal)
  if (config.sandboxEnabled) {
    await registerExecutionSandbox(api, config);
  }

  // Module 4: Skill Loop (auto-creation, marketplace)
  if (config.skillLoopEnabled) {
    await registerSkillLoop(api, config);
  }

  // Module 5: Session Intelligence (FTS5, recall, user modeling)
  if (config.sessionIntelEnabled) {
    await registerSessionIntel(api, config);
  }

  // Module 6: Security Hardening (injection scanning, tool guard)
  // Enabled by default — security should be opt-out not opt-in
  if (config.securityEnabled !== false) {
    await registerSecurity(api, config);
  }
}
```

### Updated MabosPluginConfig

```typescript
export interface MabosPluginConfig {
  // === Existing fields ===
  agents?: { defaults?: { workspace?: string } };
  workspaceDir?: string;
  ontologyDir?: string;
  cbrMaxCases?: number;
  stakeholderApprovalThresholdUsd?: number;
  bdiCycleIntervalMinutes?: number;
  cognitiveContextEnabled?: boolean;
  financialToolGuardEnabled?: boolean;
  // ... other existing flags ...

  // === New module configs ===
  governanceEnabled?: boolean;
  governance?: GovernanceConfig;

  modelRouterEnabled?: boolean;
  modelRouter?: ModelRouterConfig;

  sandboxEnabled?: boolean;
  sandbox?: ExecutionSandboxConfig;

  skillLoopEnabled?: boolean;
  skillLoop?: SkillLoopConfig;

  sessionIntelEnabled?: boolean;
  sessionIntel?: SessionIntelConfig;

  securityEnabled?: boolean;              // Default: true
  security?: SecurityConfig;
}
```

---

## Data Flow: The Unified System

```
                         ┌──────────────────────────────────┐
                         │       MISSION CONTROL            │
                         │    (Operator Dashboard)          │
                         │  + Command Palette (Module 7)    │
                         │  + Budget Dashboard (Module 7)   │
                         │  + Skill Marketplace (Module 7)  │
                         │  + Session Search (Module 7)     │
                         │  + Security Dashboard (Module 7) │
                         └────────────┬─────────────────────┘
                                      │ REST + SSE
                         ┌────────────▼─────────────────────┐
                         │     OPENCLAW GATEWAY              │
                         │     (port 18789)                  │
                         ├───────────────────────────────────┤
                         │  SECURITY (Module 6)              │
                         │  ├── Injection scanner            │
                         │  ├── Tool approval guard          │
                         │  └── URL/SSRF validator           │
                         ├───────────────────────────────────┤
                         │  GOVERNANCE (Module 1)            │
                         │  ├── Budget ledger (atomic)       │
                         │  ├── RBAC policy engine           │
                         │  ├── Audit log (append-only)      │
                         │  └── Multi-company scope          │
                         ├───────────────────────────────────┤
                         │  MODEL ROUTER (Module 2)          │
                         │  ├── Provider registry (10+)      │
                         │  ├── Fallback chains              │
                         │  ├── Prompt caching               │
                         │  └── MoA ensemble                 │
                         ├───────────────────────────────────┤
                         │  EXECUTION SANDBOX (Module 3)     │
                         │  ├── Docker containers            │
                         │  ├── SSH remote hosts             │
                         │  └── Modal serverless             │
                         ├───────────────────────────────────┤
                         │  SESSION INTEL (Module 5)         │
                         │  ├── FTS5 session index           │
                         │  ├── Cross-session recall         │
                         │  └── User profile builder         │
                         ├───────────────────────────────────┤
                         │  SKILL LOOP (Module 4)            │
                         │  ├── Auto-creation from sessions  │
                         │  ├── Local registry               │
                         │  ├── Marketplace integration      │
                         │  └── Prompt injection             │
                         ├───────────────────────────────────┤
                         │  EXISTING MABOS CORE              │
                         │  ├── BDI cognitive cycle          │
                         │  ├── 35 reasoning methods         │
                         │  ├── TypeDB knowledge graphs      │
                         │  ├── SBVR ontology engine         │
                         │  ├── 99 business tools            │
                         │  ├── ERP + Shopify + CRM          │
                         │  └── 35+ messaging channels       │
                         └───────────────────────────────────┘
```

---

## Implementation Order

Build in dependency order — each module is independently deployable:

| Phase | Module | Deps | Effort | Why First |
|-------|--------|------|--------|-----------|
| 1 | **Security (6)** | None | Medium | Should be on by default; protects everything else |
| 2 | **Governance (1)** | Security | Large | Budget + audit needed before scaling agent usage |
| 3 | **Model Router (2)** | Governance (for cost tracking) | Medium | Enables model flexibility + cost optimization |
| 4 | **Session Intel (5)** | None | Medium | Independent; immediate value for agent recall |
| 5 | **Execution Sandbox (3)** | Security (for approval) | Medium | Enables safe code execution |
| 6 | **Skill Loop (4)** | Session Intel (for history analysis) | Large | Builds on session data for skill extraction |
| 7 | **UI Enhancements (7)** | All above (consumes their APIs) | Large | Dashboard for everything above |

---

## New Tools Summary (All Modules)

| Module | Tool | Description |
|--------|------|-------------|
| Governance | `budget_status` | Check remaining budget |
| Governance | `budget_request` | Request budget increase |
| Governance | `audit_query` | Search audit trail |
| Model Router | `model_switch` | Change model mid-conversation |
| Model Router | `model_list` | List available models + pricing |
| Model Router | `reason_ensemble` | MoA multi-model reasoning |
| Model Router | `model_cost` | Estimate prompt cost |
| Sandbox | `sandbox_exec` | Execute in isolated container |
| Sandbox | `sandbox_upload` | Upload file to sandbox |
| Sandbox | `sandbox_download` | Download file from sandbox |
| Skill Loop | `skill_create` | Create new skill |
| Skill Loop | `skill_search` | Search local + marketplace |
| Skill Loop | `skill_install` | Install from marketplace |
| Skill Loop | `skill_list` | List installed skills |
| Skill Loop | `skill_run` | Execute a named skill |
| Session Intel | `session_search` | FTS search past sessions |
| Session Intel | `session_recall` | Retrieve + summarize past context |
| Session Intel | `user_profile` | View/update user profile |

**Total: 18 new tools** (bringing MABOS to 117 tools)

---

## New HTTP Routes Summary

| Module | Route | Method | Description |
|--------|-------|--------|-------------|
| Governance | `/mabos/governance/budget/:agentId` | GET | Agent budget status |
| Governance | `/mabos/governance/budget/summary` | GET | All budgets overview |
| Governance | `/mabos/governance/budget/allocate` | POST | Create/update allocation |
| Governance | `/mabos/governance/costs` | GET | Cost event history |
| Governance | `/mabos/governance/audit` | GET | Audit log query |
| Governance | `/mabos/governance/roles` | GET | RBAC role definitions |
| Governance | `/mabos/governance/roles/:agentId` | POST | Assign role |
| Model Router | `/mabos/models/list` | GET | Available models |
| Model Router | `/mabos/models/health` | GET | Provider health status |
| Sandbox | `/mabos/sandbox/status` | GET | Active sandboxes |
| Sandbox | `/mabos/sandbox/:taskId/destroy` | POST | Destroy sandbox |
| Skill Loop | `/mabos/skills` | GET | List skills |
| Skill Loop | `/mabos/skills/search` | GET | Search marketplace |
| Skill Loop | `/mabos/skills/install` | POST | Install skill |
| Session Intel | `/mabos/sessions/search` | GET | FTS search |
| Session Intel | `/mabos/sessions/recall` | POST | Cross-session recall |
| Security | `/mabos/security/status` | GET | Threat overview |
| Security | `/mabos/security/approvals` | GET | Pending approvals |
| Security | `/mabos/security/approvals/:id` | POST | Approve/deny |
| Security | `/mabos/security/scan-log` | GET | Scan history |

---

## Config Example (Full)

```yaml
# openclaw config for unified MABOS
mabos:
  workspaceDir: ~/.openclaw/workspace
  bdiCycleIntervalMinutes: 30
  cognitiveContextEnabled: true

  # Module 1: Governance
  governanceEnabled: true
  governance:
    budget:
      enabled: true
      defaultDailyLimitUsd: 50
      defaultMonthlyLimitUsd: 500
      requireApprovalAboveUsd: 25
    rbac:
      enabled: true
      defaultRole: agent
    audit:
      enabled: true
      retentionDays: 90

  # Module 2: Model Router
  modelRouterEnabled: true
  modelRouter:
    defaultProvider: anthropic
    fallbackChain:
      - anthropic/claude-opus-4-6
      - openai/gpt-4.1
      - openrouter/deepseek/deepseek-chat
    promptCaching:
      enabled: true
    moa:
      enabled: true
      referenceModels:
        - anthropic/claude-opus-4-6
        - openai/gpt-4.1
        - google/gemini-2.5-pro
        - deepseek/deepseek-r1

  # Module 3: Execution Sandbox
  sandboxEnabled: true
  sandbox:
    defaultBackend: docker
    docker:
      image: mabos-sandbox:latest
      memoryLimitMb: 512
      networkMode: bridge

  # Module 4: Skill Loop
  skillLoopEnabled: true
  skillLoop:
    creationNudgeInterval: 10
    marketplace:
      enabled: true
      sources:
        - { name: "ClawHub", type: "clawhub" }
        - { name: "Local", type: "local" }

  # Module 5: Session Intelligence
  sessionIntelEnabled: true
  sessionIntel:
    fts:
      enabled: true
    recall:
      enabled: true
      summarizeResults: true
    userModel:
      enabled: true
      updateInterval: 5

  # Module 6: Security (on by default)
  securityEnabled: true
  security:
    injectionScanning:
      enabled: true
      blockOnDetection: true
    toolGuard:
      enabled: true
    ssrf:
      enabled: true
```

---

## What This Achieves

After implementation, OpenClaw-MABOS will have:

| Capability | Before | After |
|------------|--------|-------|
| **Budget enforcement** | Manual threshold flag | Atomic reservation ledger with daily/monthly caps |
| **Auth/RBAC** | Bearer token only | Role-based permissions with per-tool policies |
| **Audit trail** | None | Append-only SQLite with full event history |
| **Multi-company** | Single business scope | Company-isolated data partitioning |
| **Model providers** | Single provider (pi-agent) | 10+ providers with instant switching |
| **Model fallback** | None | Automatic fallback chain on failure |
| **Ensemble reasoning** | None | MoA (4-model reference + aggregator) |
| **Prompt caching** | None | Anthropic cache control optimization |
| **Code execution** | Local shell only | Docker, SSH, Modal sandboxed backends |
| **Skill creation** | Manual tool definitions | Autonomous extraction from sessions |
| **Skill marketplace** | None | Browse/install from ClawHub + community |
| **Session search** | None | FTS5 full-text search across all sessions |
| **Cross-session recall** | None | LLM-summarized past context retrieval |
| **User modeling** | None | Dialectic profile builder |
| **Injection defense** | None | Pattern scanning on all inputs/outputs |
| **Tool approval** | Threshold-only | Per-tool approval gates with timeout |
| **SSRF prevention** | None | URL validation for all HTTP-accepting tools |
| **Dashboard** | Basic React | Command palette, budget gauges, skill marketplace, security dashboard |
| **Total tools** | 99 | 117 |
| **Total HTTP routes** | ~20 | ~40 |
