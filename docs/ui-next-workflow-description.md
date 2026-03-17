# Cách UI-Next Lưu Description cho Cron Job

## 📋 Tổng Quan

Khi lưu workflow từ UI-Next, **description** của cron job được tạo tự động từ workflow chain.

## 🔍 Luồng Xử Lý

### **File:** `ui-next/app/workflows/use-workflows.ts`

### **Bước 1: Extract Chain từ Workflow**

```typescript
// Line 113: Function extract chain từ trigger node
function extractChainFromTrigger(
  triggerId: string,
  nodes: Node[],
  edges: Edge[],
): WorkflowChainStep[] {
  const chain: WorkflowChainStep[] = [];
  const visited = new Set<string>();

  // Find all edges from trigger
  const outgoingEdges = edges.filter((e) => e.source === triggerId);

  for (const edge of outgoingEdges) {
    const step = extractNodeChain(edge.target, nodes, edges, visited);
    if (step) {
      chain.push(step);
    }
  }

  return chain;
}
```

### **Bước 2: Build Chain Step từ Node**

```typescript
// Line 159: Extract node chain recursively
function extractNodeChain(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  visited: Set<string>,
): WorkflowChainStep | null {
  if (visited.has(nodeId)) {
    return null;
  }
  visited.add(nodeId);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    return null;
  }

  const label = (node.data?.label as string) || "";
  const rawActionType = node.data?.actionType as string | undefined;

  // Determine action type
  let actionType =
    rawActionType ||
    (label === "AI Agent Prompt" ? "agent-prompt" : "") ||
    (label === "Send Message" ? "send-message" : "") ||
    (label === "If / Else" ? "if-else" : "") ||
    "unknown";

  // Build step config
  const step: WorkflowChainStep = {
    nodeId,
    actionType,
    label,
    agentId: (node.data?.agentId as string) || undefined,
    prompt: (node.data?.prompt as string) || undefined,
    outputSchema: (node.data?.outputSchema as string)
      ? JSON.parse(node.data.outputSchema as string)
      : undefined,
    body: (node.data?.body as string) || undefined,
    channel: (node.data?.channel as string) || undefined,
    recipientId: (node.data?.recipientId as string) || undefined,
    accountId: (node.data?.accountId as string) || undefined,
    condition: (node.data?.condition as string) || undefined,

    // If/Else branching
    trueChain: undefined, // Will be populated for If/Else nodes
    falseChain: undefined,
  };

  // Handle If/Else branching
  if (actionType === "if-else") {
    const outgoingEdges = edges.filter((e) => e.source === nodeId);

    for (const edge of outgoingEdges) {
      const edgeLabel = (
        (edge.data?.label as string) ||
        (edge.label as string) ||
        ""
      ).toLowerCase();
      const sourceHandle = edge.sourceHandle as string | undefined;

      const isTrueBranch = sourceHandle === "true" || edgeLabel === "true" || edgeLabel === "yes";
      const isFalseBranch = sourceHandle === "false" || edgeLabel === "false" || edgeLabel === "no";

      const nextStep = extractNodeChain(edge.target, nodes, edges, visited);

      if (nextStep) {
        if (isTrueBranch) {
          step.trueChain = [nextStep];
        } else if (isFalseBranch) {
          step.falseChain = [nextStep];
        }
      }
    }
  }

  // Handle next step in chain
  if (actionType !== "if-else") {
    const outgoingEdges = edges.filter((e) => e.source === nodeId);

    if (outgoingEdges.length > 0) {
      const nextEdge = outgoingEdges[0];
      const nextStep = extractNodeChain(nextEdge.target, nodes, edges, visited);

      if (nextStep) {
        step.trueChain = [nextStep]; // Store next step in trueChain for compatibility
      }
    }
  }

  return step;
}
```

### **Bước 3: Encode Chain vào Description**

```typescript
// Line 485-490: Encode chain vào description
const WF_CHAIN_PREFIX = "__wf_chain__:";

const description =
  chain.length > 0
    ? `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`
    : `Generated from Workflow Editor (trigger: ${trigger.id})`;

console.log("[WORKFLOW DEBUG] Chain description:", description.substring(0, 1000));
console.log("[WORKFLOW DEBUG] Full chain structure:", JSON.stringify(chain, null, 2));
```

### **Bước 4: Attach Description vào Cron Job**

```typescript
// Line 500-520: Create cron job with description
const jobCreate: CronJobCreate = {
  name: `Workflow: ${name}`,
  description, // ✅ Description được attach ở đây
  enabled: true,
  agentId,
  schedule: { kind: "cron", expr: cronExpr },
  sessionTarget: sessionConfig?.target || "isolated",
  wakeMode: "now",
  payload: {
    kind: "agentTurn",
    message: firstStep.prompt || firstStep.body || "Ping from Workflow",
  },
};
```

## 📊 Description Format

### **Example Description:**

```json
__wf_chain__:[
  {
    "nodeId": "2",
    "actionType": "agent-prompt",
    "label": "AI Agent Prompt",
    "prompt": "Phân tích dự án tại users/tendoo/documents/wordlet-documents",
    "agentId": "main"
  },
  {
    "nodeId": "dndnode_0",
    "actionType": "agent-prompt",
    "label": "AI Agent Prompt",
    "prompt": "Lên kế hoạch để cải thiện UI/UX...",
    "trueChain": [
      {
        "nodeId": "step-3",
        "actionType": "send-message",
        "label": "Send Message",
        "body": "Send results to Telegram"
      }
    ]
  }
]
```

### **Description Structure:**

```typescript
{
  prefix: "__wf_chain__:",
  chain: [
    {
      nodeId: string,           // ID từ ReactFlow node
      actionType: string,       // "agent-prompt", "send-message", "if-else", etc.
      label: string,            // Label hiển thị trong UI
      prompt?: string,          // Prompt cho agent-prompt
      body?: string,            // Body cho send-message
      agentId?: string,         // Agent ID to use
      condition?: string,       // Condition cho if-else
      trueChain?: WorkflowChainStep[],  // Next steps
      falseChain?: WorkflowChainStep[], // Else branch
      delivery?: {              // Delivery config
        mode: "announce" | "none";
        channel?: string;
        to?: string;
        bestEffort?: boolean;
      }
    }
  ]
}
```

## 🔍 Backend Parsing

### **File:** `src/infra/cron/server-cron.ts`

```typescript
// Line 62: Parse workflow chain từ description
export function parseWorkflowChainFromDescription(
  description: string | undefined,
): WorkflowChainStep[] | null {
  if (!description) {
    return null;
  }

  const prefixIndex = description.indexOf(WF_CHAIN_PREFIX);
  if (prefixIndex === -1) {
    return null;
  }

  try {
    const jsonStart = prefixIndex + WF_CHAIN_PREFIX.length;
    const jsonStr = description.substring(jsonStart).trim();

    if (!jsonStr.startsWith("[")) {
      return null;
    }

    const chain = JSON.parse(jsonStr) as WorkflowChainStep[];

    if (!Array.isArray(chain)) {
      return null;
    }

    logDebug(`[workflow] Parsed ${chain.length} steps from description`);
    return chain;
  } catch (error) {
    logWarn(
      `[workflow] Failed to parse workflow chain from description: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
```

## 🎯 Node Types Supported

### **1. AI Agent Prompt**

```typescript
{
  nodeId: "node-1",
  actionType: "agent-prompt",
  label: "AI Agent Prompt",
  prompt: "Your prompt here",
  agentId: "main",
  delivery: {
    mode: "announce",
    channel: "telegram"
  }
}
```

### **2. Send Message**

```typescript
{
  nodeId: "node-2",
  actionType: "send-message",
  label: "Send Message",
  body: "Message content",
  channel: "telegram",
  recipientId: "@user",
  accountId: "account-123"
}
```

### **3. If / Else**

```typescript
{
  nodeId: "node-3",
  actionType: "if-else",
  label: "If / Else",
  condition: "input.includes('urgent')",
  trueChain: [
    {
      nodeId: "node-4",
      actionType: "agent-prompt",
      label: "Urgent Response",
      prompt: "Handle urgent message"
    }
  ],
  falseChain: [
    {
      nodeId: "node-5",
      actionType: "agent-prompt",
      label: "Normal Response",
      prompt: "Handle normal message"
    }
  ]
}
```

### **4. Supabase Operations**

```typescript
{
  nodeId: "node-6",
  actionType: "supabase-select",
  label: "Query Database",
  supabaseInstance: "default",
  table: "users",
  columns: "id,name,email",
  filters: { status: "active" },
  limit: 10
}
```

## 🧪 Testing

### **Test 1: Simple Chain**

```typescript
// Create workflow: Trigger → Agent Prompt → Send Message
const nodes = [
  { id: "1", type: "trigger", data: { label: "Schedule (Cron)", cronExpr: "* * * * *" } },
  { id: "2", type: "action", data: { label: "AI Agent Prompt", prompt: "Analyze this" } },
  { id: "3", type: "action", data: { label: "Send Message", body: "Send results" } },
];

const edges = [
  { source: "1", target: "2" },
  { source: "2", target: "3" },
];

const chain = extractChainFromTrigger("1", nodes, edges);
// Expected: 2 steps in chain

const description = `__wf_chain__:${JSON.stringify(chain, null, 2)}`;
// Expected: "__wf_chain__:[{...}, {...}]"
```

### **Test 2: If/Else Branching**

```typescript
// Create workflow: Trigger → If/Else → (True: Agent, False: Send Message)
const nodes = [
  { id: "1", type: "trigger", data: { label: "Schedule (Cron)" } },
  { id: "2", type: "logic", data: { label: "If / Else", condition: "input.includes('urgent')" } },
  { id: "3", type: "action", data: { label: "Urgent Response", prompt: "Handle urgent" } },
  { id: "4", type: "action", data: { label: "Normal Response", prompt: "Handle normal" } },
];

const edges = [
  { source: "1", target: "2" },
  { source: "2", target: "3", data: { label: "true" } },
  { source: "2", target: "4", data: { label: "false" } },
];

const chain = extractChainFromTrigger("1", nodes, edges);
// Expected: 1 step (If/Else) with trueChain and falseChain

const description = `__wf_chain__:${JSON.stringify(chain, null, 2)}`;
// Expected: "__wf_chain__:[{..., trueChain: [...], falseChain: [...]}]"
```

### **Test 3: Verify Backend Parsing**

```bash
# Create cron job with workflow description
openclaw cron add \
  --name "Test Workflow" \
  --cron "* * * * *" \
  --isolated \
  --message "Test" \
  --description '__wf_chain__:[{"nodeId":"1","actionType":"agent-prompt","label":"Test","prompt":"Hello"}]'

# Verify parsing
openclaw cron list | jq '.[] | select(.name == "Test Workflow") | .description'

# Run and check logs
openclaw cron run <job-id>
tail -f ~/.openclaw/logs/gateway.log | grep "Parsed.*steps from description"
```

## 📝 Best Practices

### **1. Keep Description Concise**

```typescript
// ❌ Too verbose
const description = `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 4)}`;

// ✅ Concise
const description = `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`;
```

### **2. Handle Empty Chains**

```typescript
// ✅ Good: Handle empty chain
const description =
  chain.length > 0
    ? `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`
    : `Generated from Workflow Editor (trigger: ${trigger.id})`;
```

### **3. Validate Before Save**

```typescript
// Validate chain before saving
if (chain.length === 0) {
  console.warn("[WORKFLOW] Empty chain, cron job will have no actions");
}

// Validate description length
if (description.length > 10000) {
  console.warn("[WORKFLOW] Description very long, may cause issues");
}
```

### **4. Preserve Delivery Config**

```typescript
// Include delivery config in chain step
const step: WorkflowChainStep = {
  nodeId,
  actionType,
  label,
  prompt,
  delivery: {
    mode: node.data.deliveryMode || "announce",
    channel: node.data.deliveryChannel || "last",
    to: node.data.deliveryTo,
    bestEffort: node.data.deliveryBestEffort,
  },
};
```

## ⚠️ Common Issues

### **Issue 1: Description Too Long**

**Problem:**

```typescript
// Workflow với nhiều nodes → description rất dài
const description = `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`;
// Có thể > 10KB
```

**Solution:**

- Keep prompts concise
- Remove unnecessary whitespace
- Consider compression for very large workflows

### **Issue 2: Circular References**

**Problem:**

```typescript
// Workflow có cycle → infinite recursion
function extractNodeChain(nodeId, nodes, edges, visited) {
  // Missing: if (visited.has(nodeId)) return null;
  // → Stack overflow
}
```

**Solution:**

- Always track visited nodes
- Validate workflow has no cycles before save

### **Issue 3: Missing Edge Labels for If/Else**

**Problem:**

```typescript
// If/Else edges không có label "true"/"false"
const edges = [
  { source: "if-node", target: "true-branch" }, // Missing label
  { source: "if-node", target: "false-branch" }, // Missing label
];
```

**Solution:**

- Validate If/Else edges have labels
- Use sourceHandle from custom If/Else node

## 🔗 Related Files

- **UI Serialization:** `ui-next/app/workflows/use-workflows.ts`
- **Backend Parsing:** `src/infra/cron/server-cron.ts`
- **Workflow Executor:** `src/infra/cron/workflow-executor.ts`
- **Types:** `ui-next/app/workflows/use-workflows.ts` (WorkflowChainStep interface)

## ✅ Summary

**Quy trình lưu description:**

1. **Extract chain** từ workflow nodes + edges
2. **Build WorkflowChainStep** objects
3. **JSON.stringify** chain với prefix `__wf_chain__:`
4. **Attach** vào cron job description
5. **Backend parse** khi execute

**Description format:**

```
__wf_chain__:[{nodeId, actionType, label, prompt, ...}]
```

**Backend parsing:**

```typescript
parseWorkflowChainFromDescription(description) → WorkflowChainStep[]
```

**Happy Workflowing! 🔄**
