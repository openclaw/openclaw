# Workflow Nodes Upgrade Plan

**Date:** March 9, 2026  
**Status:** Phase 1 Complete ✅  
**Priority:** High

---

## Executive Summary

### Hiện Trạng Workflow System

| Component                  | Status      | Notes                                    |
| -------------------------- | ----------- | ---------------------------------------- |
| Visual Editor (React Flow) | ✅ Complete | Drag-drop, connections, config panel     |
| Schedule (Cron) Trigger    | ✅ Complete | Cron expression, chain execution         |
| AI Agent Prompt Action     | ✅ Complete | Template rendering, sequential execution |
| Send Message Action        | ✅ Complete | Full channel/recipient config + delivery |
| Chat Message Trigger       | ✅ Complete | Backend event listener implemented       |
| Error Handling & Retry     | ✅ Complete | Exponential backoff retry logic          |
| Execute Tool Action        | ❌ Missing  | No implementation                        |
| Remote Invoke Action       | ❌ Missing  | No implementation                        |
| Speak (TTS) Action         | ❌ Missing  | No implementation                        |
| If/Else Logic              | ❌ Missing  | No branching support                     |
| Delay Logic                | ❌ Missing  | No state persistence                     |
| Custom JS Logic            | ❌ Missing  | Security concerns                        |

### Vấn Đề Cần Giải Quyết

1. **Backend execution** chỉ hỗ trợ 2 action types: `agent-prompt` và `send-message` (basic)
2. **Chat Message trigger** có UI nhưng không có backend event listener
3. **Logic nodes** (If/Else, Delay) không được xử lý trong chain execution
4. **Send Message** không có cấu hình channel/recipient
5. **Không có test coverage** cho workflow execution
6. **Không có error recovery** hay retry logic

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2) 🔴 HIGH PRIORITY

**Goal:** Hoàn thiện các node cơ bản để workflow có thể chạy end-to-end

#### 1.1 Chat Message Trigger (Backend)

**Files to create:**

- `src/gateway/workflow-triggers.ts` - Trigger service
- `src/gateway/workflow-triggers.test.ts` - Unit tests

**Implementation:**

```typescript
// src/gateway/workflow-triggers.ts
import { getChildLogger } from "../logging.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";

export interface ChatTriggerConfig {
  workflowId: string;
  sessionKey: string;
  matchKeyword?: string;
  cronJobId: string;
}

export class WorkflowTriggerService {
  private chatListeners = new Map<string, Set<ChatTriggerConfig>>();
  private logger = getChildLogger({ module: "workflow-triggers" });

  /**
   * Register a chat message trigger for a workflow
   */
  registerChatTrigger(config: ChatTriggerConfig): void {
    const { sessionKey } = config;

    if (!this.chatListeners.has(sessionKey)) {
      this.chatListeners.set(sessionKey, new Set());

      // Register event listener for this session
      registerInternalHook("message:received", async (event) => {
        await this.onMessageReceived(event.sessionKey, event.message);
      });
    }

    this.chatListeners.get(sessionKey)!.add(config);
    this.logger.info(
      {
        workflowId: config.workflowId,
        sessionKey,
        keyword: config.matchKeyword,
      },
      "registered chat trigger",
    );
  }

  /**
   * Unregister all triggers for a workflow
   */
  unregisterWorkflow(workflowId: string): void {
    for (const [sessionKey, configs] of this.chatListeners.entries()) {
      const filtered = new Set([...configs].filter((c) => c.workflowId !== workflowId));

      if (filtered.size === 0) {
        this.chatListeners.delete(sessionKey);
      } else {
        this.chatListeners.set(sessionKey, filtered);
      }
    }
  }

  /**
   * Handle incoming message and trigger matching workflows
   */
  private async onMessageReceived(sessionKey: string, message: string): Promise<void> {
    const configs = this.chatListeners.get(sessionKey);
    if (!configs) return;

    for (const config of configs) {
      // Check keyword filter
      if (config.matchKeyword && !message.includes(config.matchKeyword)) {
        continue;
      }

      this.logger.info(
        {
          workflowId: config.workflowId,
          sessionKey,
          message: message.substring(0, 100),
        },
        "chat trigger matched, executing workflow",
      );

      // Trigger workflow execution via cron job
      // This will be handled by existing cron infrastructure
      // We just need to enqueue the event with proper metadata
      enqueueSystemEvent(message, {
        sessionKey: `workflow:${config.workflowId}`,
        contextKey: `trigger:${config.cronJobId}`,
      });
    }
  }
}

// Singleton instance
export const workflowTriggerService = new WorkflowTriggerService();
```

**Integration with workflow save:**

- Modify `ui-next/app/workflows/use-workflows.ts` to send trigger config when saving
- Modify `src/gateway/server-methods/workflows.ts` to register triggers

---

#### 1.2 Send Message Action (Full Implementation)

**Files to modify:**

- `ui-next/app/workflows/node-config.tsx` - Add channel config UI
- `ui-next/app/workflows/use-workflows.ts` - Include channel config in chain
- `src/gateway/server-cron.ts` - Enhanced send-message execution

**Frontend Config UI:**

```typescript
// Add to ui-next/app/workflows/node-config.tsx

{data.label === "Send Message" && (
  <>
    <div style={styles.field}>
      <span style={styles.label}>Channel</span>
      <select
        style={styles.select}
        value={(data.channel as string) || ""}
        onChange={(e) => handleChange("channel", e.target.value)}
      >
        <option value="">-- Select channel --</option>
        <option value="slack">Slack</option>
        <option value="discord">Discord</option>
        <option value="telegram">Telegram</option>
        <option value="line">LINE</option>
        <option value="whatsapp">WhatsApp</option>
      </select>
    </div>

    <div style={styles.field}>
      <span style={styles.label}>Recipient ID</span>
      <input
        style={styles.input}
        placeholder="User ID, Channel ID, or @mention"
        value={(data.recipientId as string) || ""}
        onChange={(e) => handleChange("recipientId", e.target.value)}
      />
    </div>

    <div style={styles.field}>
      <span style={styles.label}>Account (Optional)</span>
      <input
        style={styles.input}
        placeholder="Leave blank for default"
        value={(data.accountId as string) || ""}
        onChange={(e) => handleChange("accountId", e.target.value)}
      />
    </div>

    <div style={styles.field}>
      <span style={styles.label}>Message Body</span>
      <textarea
        style={styles.textarea}
        placeholder="Hello! {{input}}"
        value={(data.body as string) || ""}
        onChange={(e) => handleChange("body", e.target.value)}
      />
    </div>
  </>
)}
```

**Backend Execution:**

```typescript
// Modify src/gateway/server-cron.ts send-message step

else if (step.actionType === "send-message" || step.label === "Send Message") {
  const body = (step.body || currentInput).replace(/\{\{input\}\}/g, currentInput);
  const channel = (step as any).channel;
  const recipientId = (step as any).recipientId;
  const accountId = (step as any).accountId;

  cronLogger.info(
    {
      jobId: job.id,
      step: stepIdx + 1,
      nodeId: step.nodeId,
      channel,
      recipientId,
      body: body,
    },
    `cron: [STEP ${stepIdx + 1}/${chain.length}] 📤 SEND-MESSAGE - Node "${step.label || step.nodeId}"`,
  );

  if (channel && recipientId) {
    // Use full delivery system
    const { createOutboundSendDeps } = await import("../cli/outbound-send-deps.js");
    const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");

    await deliverOutboundPayloads({
      cfg: stepCfg,
      channel,
      to: recipientId,
      accountId: accountId || undefined,
      threadId: undefined,
      payloads: [{ text: body }],
      deps: createOutboundSendDeps(params.deps),
    });

    cronLogger.info(
      { jobId: job.id, step: stepIdx + 1, delivered: true },
      `cron: [STEP ${stepIdx + 1}/${chain.length}] ✅ DELIVERED`,
    );
  } else {
    // Fallback to enqueueSystemEvent (current behavior)
    enqueueSystemEvent(body, { sessionKey });
    cronLogger.warn(
      { jobId: job.id, step: stepIdx + 1, reason: "missing channel or recipient" },
      `cron: [STEP ${stepIdx + 1}/${chain.length}] ⚠️ ENQUEUED (no delivery config)`,
    );
  }

  lastResult = {
    status: "ok" as const,
    sessionId: sessionKey,
    sessionKey,
  };
}
```

---

#### 1.3 Error Handling & Retry

**Files to modify:**

- `src/gateway/server-cron.ts` - Add retry logic

```typescript
// Add to src/gateway/server-cron.ts

interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  delayMs: 1000,
  backoffMultiplier: 2,
};

async function executeStepWithRetry<T>(
  step: WorkflowChainStep,
  executeFn: () => Promise<T>,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      return await executeFn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < retryConfig.maxAttempts) {
        const delay = retryConfig.delayMs * Math.pow(retryConfig.backoffMultiplier, attempt - 1);
        console.log(
          `Step "${step.label}" failed, retrying in ${delay}ms (attempt ${attempt}/${retryConfig.maxAttempts})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
```

---

### Phase 2: Logic Nodes (Week 3-4) 🟡 MEDIUM PRIORITY

#### 2.1 If/Else Branching

**Concept:** Support conditional execution based on input evaluation

**Data Structure:**

```typescript
interface BranchConfig {
  condition: string; // Expression to evaluate
  trueLabel?: string; // Label for true branch
  falseLabel?: string; // Label for false branch
}

interface WorkflowChainBranch {
  nodeId: string;
  type: "branch";
  condition: string;
  trueChain: WorkflowChainStep[];
  falseChain?: WorkflowChainStep[];
}
```

**Frontend Changes:**

1. Update `extractChainFromTrigger` to handle branching
2. Support multiple outgoing edges from logic nodes
3. Encode branch structure in workflow description

**Backend Execution:**

```typescript
// src/gateway/workflow-logic.ts

import { VM } from "vm2"; // Sandboxed execution

export function evaluateCondition(params: {
  condition: string;
  context: Record<string, unknown>;
}): boolean {
  const { condition, context } = params;

  // Safe evaluation using vm2
  const vm = new VM({
    timeout: 1000,
    sandbox: { ...context },
  });

  try {
    const result = vm.run(condition);
    return Boolean(result);
  } catch (error) {
    console.error("Condition evaluation failed:", error);
    return false;
  }
}

export async function executeBranch(params: {
  branch: WorkflowChainBranch;
  context: WorkflowContext;
}): Promise<WorkflowResult> {
  const { branch, context } = params;

  const isTrue = evaluateCondition({
    condition: branch.condition,
    context: { input: context.currentInput, ...context.variables },
  });

  const chainToExecute = isTrue ? branch.trueChain : branch.falseChain || [];

  // Execute the selected chain
  return executeChain(chainToExecute, context);
}
```

**Security Considerations:**

- Use `vm2` for sandboxed execution
- Whitelist allowed operations
- No require/import
- Timeout enforcement
- Memory limits

---

#### 2.2 Delay Node

**Implementation Approach:** Cron-based state persistence

**Files to create:**

- `src/gateway/workflow-state.ts` - State management
- `src/gateway/workflow-scheduler.ts` - Delay scheduling

```typescript
// src/gateway/workflow-state.ts

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export interface WorkflowState {
  workflowId: string;
  cronJobId: string;
  currentStepIndex: number;
  chain: WorkflowChainStep[];
  currentInput: string;
  variables: Map<string, string>;
  resumeAt: number; // Timestamp
}

export class WorkflowStateManager {
  private stateDir: string;

  constructor() {
    const stateDir = resolveStateDir(process.env);
    this.stateDir = path.join(stateDir, "workflow-states");
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  async persistState(state: WorkflowState): Promise<void> {
    const filePath = path.join(this.stateDir, `${state.workflowId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  async loadState(workflowId: string): Promise<WorkflowState | null> {
    const filePath = path.join(this.stateDir, `${workflowId}.json`);
    if (!fs.existsSync(filePath)) return null;

    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  }

  async clearState(workflowId: string): Promise<void> {
    const filePath = path.join(this.stateDir, `${workflowId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
```

**Delay Execution:**

```typescript
// In server-cron.ts delay step handler

else if (step.actionType === "delay") {
  const durationMs = (step as any).duration * getDurationMultiplier((step as any).durationType);
  const resumeAt = Date.now() + durationMs;

  // Persist current state
  await stateManager.persistState({
    workflowId: job.id,
    cronJobId: job.id,
    currentStepIndex: stepIdx,
    chain,
    currentInput,
    variables: new Map(),
    resumeAt,
  });

  // Schedule resume via cron
  const resumeCronExpr = calculateResumeCron(resumeAt);
  await request("cron.add", {
    name: `Resume workflow: ${job.id}`,
    description: `__wf_resume__:${job.id}`,
    schedule: { kind: "cron", expr: resumeCronExpr },
    payload: { kind: "workflowResume", workflowId: job.id },
  });

  cronLogger.info(
    { jobId: job.id, resumeAt, delayMs: durationMs },
    `cron: [STEP ${stepIdx + 1}/${chain.length}] ⏸️ DELAY - Workflow paused`,
  );

  // Return early - workflow will resume later
  return {
    status: "paused" as const,
    sessionId: `cron:${job.id}`,
    sessionKey: `cron:${job.id}`,
  };
}
```

---

### Phase 3: Advanced Actions (Week 5-6) 🟢 LOW PRIORITY

#### 3.1 Execute Tool Action

**Files to create:**

- `src/gateway/workflow-actions.ts` - Action execution engine

```typescript
// src/gateway/workflow-actions.ts

import { loadToolFromCatalog } from "../agents/tools/catalog.js";

export interface ExecuteToolConfig {
  toolName: string;
  parameters?: Record<string, unknown>;
  timeout?: number;
}

export async function executeTool(params: ExecuteToolConfig): Promise<{
  output: string;
  success: boolean;
  error?: string;
}> {
  const { toolName, parameters = {}, timeout = 30000 } = params;

  try {
    const tool = await loadToolFromCatalog(toolName);
    if (!tool) {
      return {
        output: "",
        success: false,
        error: `Tool "${toolName}" not found`,
      };
    }

    // Validate parameters against tool schema
    const validation = validateToolParams(tool, parameters);
    if (!validation.valid) {
      return {
        output: "",
        success: false,
        error: validation.error,
      };
    }

    // Execute with timeout
    const result = await Promise.race([
      tool.execute(parameters),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeout)),
    ]);

    return {
      output: String(result),
      success: true,
    };
  } catch (error) {
    return {
      output: "",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
```

---

#### 3.2 Remote Invoke Action

**Implementation:** Use existing node IPC system

```typescript
// src/gateway/workflow-actions.ts

export async function remoteNodeInvoke(params: {
  nodeId: string;
  command: string;
  commandType: "shell" | "app" | "custom";
  timeout?: number;
}): Promise<{
  output: string;
  exitCode: number;
  success: boolean;
}> {
  const { nodeId, command, commandType, timeout = 60000 } = params;

  // Get node session from registry
  const { nodeRegistry } = await import("./node-registry.js");
  const nodeSession = nodeRegistry.getSession(nodeId);

  if (!nodeSession) {
    return {
      output: "",
      exitCode: -1,
      success: false,
      error: `Node "${nodeId}" not found`,
    };
  }

  // Send command via IPC
  const result = await nodeSession.invoke({
    type: commandType,
    command,
    timeout,
  });

  return {
    output: result.output,
    exitCode: result.exitCode,
    success: result.success,
  };
}
```

---

#### 3.3 Speak (TTS) Action

**Implementation:** Integrate with TTS providers

```typescript
// src/gateway/workflow-actions.ts

export async function textToSpeech(params: {
  text: string;
  voice?: string;
  language?: string;
  targetNodeId?: string;
}): Promise<void> {
  const { text, voice, language = "en-US", targetNodeId } = params;

  // Generate audio using TTS provider
  const { generateSpeech } = await import("../media/tts.js");
  const audioBuffer = await generateSpeech({ text, voice, language });

  if (targetNodeId) {
    // Send to specific node for playback
    const { nodeRegistry } = await import("./node-registry.js");
    const nodeSession = nodeRegistry.getSession(targetNodeId);

    if (nodeSession) {
      await nodeSession.invoke({
        type: "media:play",
        audio: audioBuffer.toString("base64"),
        format: "mp3",
      });
    }
  } else {
    // Save audio file for later use
    const { saveAudioFile } = await import("../media/storage.js");
    await saveAudioFile(audioBuffer);
  }
}
```

---

## File Change Summary

### New Files

```
src/gateway/
├── workflow-triggers.ts           # Chat & event triggers
├── workflow-triggers.test.ts      # Trigger tests
├── workflow-actions.ts            # Action execution engine
├── workflow-actions.test.ts       # Action tests
├── workflow-logic.ts              # Logic node execution
├── workflow-logic.test.ts         # Logic tests
├── workflow-state.ts              # State persistence
├── workflow-state.test.ts         # State tests
└── workflow-scheduler.ts          # Delay scheduling

test/
└── workflow/
    ├── executor.test.ts
    ├── triggers.test.ts
    ├── actions.test.ts
    ├── logic.test.ts
    └── integration.test.ts
```

### Modified Files

```
src/gateway/
├── server-cron.ts                 # Enhanced chain execution
└── server-methods/
    └── workflows.ts               # Trigger registration

ui-next/app/workflows/
├── use-workflows.ts               # Enhanced chain extraction
├── node-config.tsx                # New config panels
└── custom-nodes.tsx               # Enhanced rendering
```

---

## Testing Strategy

### Unit Tests

```typescript
// test/workflow/triggers.test.ts
describe("WorkflowTriggerService", () => {
  it("should register chat trigger", () => {
    // Test registration
  });

  it("should match keyword filter", () => {
    // Test keyword matching
  });

  it("should trigger workflow on message", async () => {
    // Test end-to-end trigger
  });
});

// test/workflow/actions.test.ts
describe("Workflow Actions", () => {
  it("should execute tool with parameters", async () => {
    // Test tool execution
  });

  it("should send message to channel", async () => {
    // Test message delivery
  });

  it("should handle timeout", async () => {
    // Test timeout handling
  });
});
```

### Integration Tests

```typescript
// test/workflow/integration.test.ts
describe("Workflow Integration", () => {
  it("should execute full workflow chain", async () => {
    // Test complete execution
  });

  it("should handle branch execution", async () => {
    // Test If/Else branching
  });

  it("should persist and resume delay", async () => {
    // Test delay node
  });
});
```

---

## Priority Matrix

| Feature              | Priority  | Effort | Dependencies      |
| -------------------- | --------- | ------ | ----------------- |
| Chat Message Trigger | 🔴 HIGH   | Medium | Event hooks       |
| Send Message (full)  | 🔴 HIGH   | Medium | Channel config    |
| Error Handling/Retry | 🔴 HIGH   | Low    | None              |
| If/Else Logic        | 🟡 MEDIUM | High   | Branching support |
| Delay Node           | 🟡 MEDIUM | Medium | State persistence |
| Execute Tool         | 🟡 MEDIUM | Medium | Tool catalog      |
| Remote Invoke        | 🟢 LOW    | High   | Node IPC          |
| Speak (TTS)          | 🟢 LOW    | Low    | TTS provider      |

---

## Success Metrics

### Functional

- [ ] All 11 node types implemented
- [ ] 80%+ test coverage
- [ ] < 1% execution failure rate
- [ ] < 5s startup latency

### User Experience

- [ ] Visual branching in editor
- [ ] Real-time status updates
- [ ] Execution history
- [ ] Clear error messages

### Security

- [ ] No critical vulnerabilities
- [ ] All inputs validated
- [ ] Audit trail implemented
- [ ] Rate limiting in place

---

## Next Steps

1. **Review and approve** this plan
2. **Create GitHub issues** for each task
3. **Set up project board** for tracking
4. **Begin Phase 1 implementation**

---

**Last Updated:** 2026-03-09
