# Cập Nhật Workflow Chain: nextStep vs trueChain

## 🎯 Thay Đổi

### **Trước (Cũ):**

```typescript
// UI-next: use-workflows.ts
if (outgoingEdges.length > 0) {
  const nextEdge = outgoingEdges[0];
  const nextStep = extractNodeChain(nextEdge.target, nodes, edges, visited);

  if (nextStep) {
    // ❌ Lưu vào trueChain (sai mục đích)
    step.trueChain = [nextStep];
  }
}
```

**Description format:**

```json
__wf_chain__:[
  {
    "nodeId": "1",
    "actionType": "agent-prompt",
    "trueChain": [  // ❌ trueChain dùng cho sequential (sai)
      {
        "nodeId": "2",
        "actionType": "agent-prompt"
      }
    ]
  }
]
```

### **Sau (Mới):**

```typescript
// UI-next: use-workflows.ts (Updated)
if (outgoingEdges.length > 0) {
  const nextEdge = outgoingEdges[0];
  const nextStep = extractNodeChain(nextEdge.target, nodes, edges, visited);

  if (nextStep) {
    // ✅ Lưu vào nextStep (đúng mục đích)
    step.nextStep = nextStep;
  }
}
```

**Description format:**

```json
__wf_chain__:[
  {
    "nodeId": "1",
    "actionType": "agent-prompt",
    "nextStep": {  // ✅ nextStep cho sequential flow
      "nodeId": "2",
      "actionType": "agent-prompt"
    }
  }
]
```

## 📝 Interface Changes

### **File:** `ui-next/app/workflows/use-workflows.ts`

```typescript
export interface WorkflowChainStep {
  nodeId: string;
  actionType: string;
  label: string;

  // ... other fields ...

  // If/Else Branching
  condition?: string;
  trueChain?: WorkflowChainStep[]; // ✅ ONLY for If/Else nodes (branches)
  falseChain?: WorkflowChainStep[]; // ✅ ONLY for If/Else nodes (branches)

  // Sequential flow (non-If/Else nodes)
  nextStep?: WorkflowChainStep; // ✅ Next step in sequence
}
```

## 🔧 Backend Handling

### **File:** `src/infra/cron/workflow-executor.ts`

Backend cần cập nhật để xử lý cả `nextStep` và `trueChain`:

```typescript
async executeWorkflow(
  workflowId: string,
  steps: WorkflowChainStep[],
): Promise<WorkflowExecutionResult> {

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Execute current step
    const result = await this.executeStep(step, context);

    // Handle sequential flow (nextStep)
    if (step.nextStep) {
      await this.executeStep(step.nextStep, context);
    }

    // Handle If/Else branching (trueChain/falseChain)
    if (step.actionType === "if-else") {
      if (result.metadata?.branchTaken === "true" && step.trueChain) {
        for (const branchStep of step.trueChain) {
          await this.executeStep(branchStep, context);
        }
      } else if (result.metadata?.branchTaken === "false" && step.falseChain) {
        for (const branchStep of step.falseChain) {
          await this.executeStep(branchStep, context);
        }
      }
    }
  }
}
```

## 📊 So Sánh

| Feature             | Before (trueChain)                | After (nextStep)          |
| ------------------- | --------------------------------- | ------------------------- |
| **Sequential flow** | `trueChain: [nextStep]`           | `nextStep: {...}`         |
| **If/Else true**    | `trueChain: [branch]`             | `trueChain: [branch]` ✅  |
| **If/Else false**   | `falseChain: [branch]`            | `falseChain: [branch]` ✅ |
| **Clarity**         | ❌ Confusing (trueChain for both) | ✅ Clear separation       |
| **Type Safety**     | ❌ Array for single step          | ✅ Single object          |
| **Backend Logic**   | ❌ Need to unwrap array           | ✅ Direct execution       |

## 🧪 Testing

### **Test 1: Sequential Workflow**

```typescript
// Workflow: Trigger → Step 1 → Step 2 → Step 3
const nodes = [
  { id: "1", type: "trigger", data: { label: "Schedule (Cron)" } },
  { id: "2", type: "action", data: { label: "Step 1", prompt: "First" } },
  { id: "3", type: "action", data: { label: "Step 2", prompt: "Second" } },
];

const edges = [
  { source: "1", target: "2" },
  { source: "2", target: "3" },
];

const chain = extractChainFromTrigger("1", nodes, edges);

// Expected output:
[
  {
    nodeId: "2",
    actionType: "agent-prompt",
    nextStep: {
      nodeId: "3",
      actionType: "agent-prompt",
    },
  },
];
```

### **Test 2: If/Else Workflow**

```typescript
// Workflow: Trigger → If/Else → (True: Step A, False: Step B)
const nodes = [
  { id: "1", type: "trigger", data: { label: "Schedule (Cron)" } },
  { id: "2", type: "logic", data: { label: "If / Else", condition: "input.includes('urgent')" } },
  { id: "3", type: "action", data: { label: "Urgent", prompt: "Handle urgent" } },
  { id: "4", type: "action", data: { label: "Normal", prompt: "Handle normal" } },
];

const edges = [
  { source: "1", target: "2" },
  { source: "2", target: "3", sourceHandle: "true" },
  { source: "2", target: "4", sourceHandle: "false" },
];

const chain = extractChainFromTrigger("1", nodes, edges);

// Expected output:
[
  {
    nodeId: "2",
    actionType: "if-else",
    condition: "input.includes('urgent')",
    trueChain: [
      {
        nodeId: "3",
        actionType: "agent-prompt",
      },
    ],
    falseChain: [
      {
        nodeId: "4",
        actionType: "agent-prompt",
      },
    ],
  },
];
```

### **Test 3: Mixed Workflow**

```typescript
// Workflow: Trigger → Step 1 → If/Else → (True: Step 2, False: Step 3) → Step 4
const nodes = [
  { id: "1", type: "trigger" },
  { id: "2", type: "action", data: { label: "Step 1" } },
  { id: "3", type: "logic", data: { label: "If / Else" } },
  { id: "4", type: "action", data: { label: "True Branch" } },
  { id: "5", type: "action", data: { label: "False Branch" } },
  { id: "6", type: "action", data: { label: "Step 4" } },
];

const edges = [
  { source: "1", target: "2" },
  { source: "2", target: "3" },
  { source: "3", target: "4", sourceHandle: "true" },
  { source: "3", target: "5", sourceHandle: "false" },
  { source: "4", target: "6" },
  { source: "5", target: "6" },
];

const chain = extractChainFromTrigger("1", nodes, edges);

// Expected output:
[
  {
    nodeId: "2",
    actionType: "agent-prompt",
    nextStep: {
      nodeId: "3",
      actionType: "if-else",
      trueChain: [{ nodeId: "4", nextStep: { nodeId: "6" } }],
      falseChain: [{ nodeId: "5", nextStep: { nodeId: "6" } }],
    },
  },
];
```

## ✅ Benefits

### **1. Clear Separation:**

- ✅ `trueChain`/`falseChain` → ONLY for If/Else branching
- ✅ `nextStep` → ONLY for sequential flow

### **2. Type Safety:**

```typescript
// Before: Array for single step (confusing)
trueChain?: WorkflowChainStep[];

// After: Single object for single step (clear)
nextStep?: WorkflowChainStep;
```

### **3. Easier Backend Logic:**

```typescript
// Before: Unwrap array
if (step.trueChain && step.trueChain.length > 0) {
  await executeStep(step.trueChain[0]);
}

// After: Direct execution
if (step.nextStep) {
  await executeStep(step.nextStep);
}
```

### **4. Better Readability:**

```json
// Before
{
  "nodeId": "1",
  "trueChain": [{ "nodeId": "2" }]  // Why array for single step?
}

// After
{
  "nodeId": "1",
  "nextStep": { "nodeId": "2" }  // Clear!
}
```

## 🔧 Migration

### **For New Workflows:**

- ✅ Automatically uses `nextStep` field
- ✅ No migration needed

### **For Existing Workflows:**

Backend should support BOTH formats during transition:

```typescript
function getNextStep(step: WorkflowChainStep): WorkflowChainStep | undefined {
  // New format (priority)
  if (step.nextStep) {
    return step.nextStep;
  }

  // Legacy format (backwards compatibility)
  if (step.trueChain && step.trueChain.length === 1) {
    return step.trueChain[0];
  }

  return undefined;
}
```

## 📝 Implementation Checklist

- [x] Update `WorkflowChainStep` interface with `nextStep` field
- [x] Update `extractNodeChain` to use `nextStep` instead of `trueChain`
- [ ] Update backend `workflow-executor.ts` to handle `nextStep`
- [ ] Add backwards compatibility for existing workflows
- [ ] Test with sequential workflows
- [ ] Test with If/Else workflows
- [ ] Test with mixed workflows
- [ ] Update documentation

## 🎯 Result

**Workflow chain structure giờ rõ ràng hơn:**

- ✅ **Sequential:** `nextStep: { nodeId: "..." }`
- ✅ **Branching:** `trueChain: [...], falseChain: [...]`
- ✅ **Type-safe:** Single object vs array
- ✅ **Easy to parse:** Backend logic đơn giản hơn

**Happy Refactoring! 🔄**
