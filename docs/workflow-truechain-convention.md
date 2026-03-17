# Workflow Chain: trueChain Convention

## 🎯 Quy Ước

### **trueChain có 2 mục đích:**

1. **If/Else nodes:** `trueChain` = nhánh TRUE
2. **Other nodes:** `trueChain` = next step (bước tiếp theo)

### **falseChain chỉ dùng cho:**

- **If/Else nodes:** `falseChain` = nhánh FALSE

## 📝 Interface

```typescript
export interface WorkflowChainStep {
  nodeId: string;
  actionType: string;
  label: string;

  // ... other fields ...

  // If/Else Branching
  condition?: string;
  trueChain?: WorkflowChainStep[]; // If/Else: true branch | Other: next step
  falseChain?: WorkflowChainStep[]; // If/Else: false branch only
}
```

## 🔍 Examples

### **1. Sequential Workflow (2 nodes)**

```json
__wf_chain__:[
  {
    "nodeId": "1",
    "actionType": "agent-prompt",
    "label": "Step 1",
    "prompt": "First step",
    "trueChain": [           // ✅ trueChain = next step
      {
        "nodeId": "2",
        "actionType": "agent-prompt",
        "label": "Step 2",
        "prompt": "Second step"
      }
    ]
  }
]
```

**Execution:**

1. Execute node 1
2. Check `trueChain` → Execute node 2
3. Done

### **2. If/Else Workflow**

```json
__wf_chain__:[
  {
    "nodeId": "1",
    "actionType": "if-else",
    "label": "Check Urgency",
    "condition": "input.includes('urgent')",
    "trueChain": [           // ✅ trueChain = TRUE branch
      {
        "nodeId": "2",
        "actionType": "agent-prompt",
        "label": "Urgent Response",
        "prompt": "Handle urgent"
      }
    ],
    "falseChain": [          // ✅ falseChain = FALSE branch
      {
        "nodeId": "3",
        "actionType": "agent-prompt",
        "label": "Normal Response",
        "prompt": "Handle normal"
      }
    ]
  }
]
```

**Execution:**

1. Execute If/Else node
2. Evaluate condition
3. If TRUE → Execute `trueChain[0]`
4. If FALSE → Execute `falseChain[0]`

### **3. Mixed Workflow (Sequential + If/Else)**

```json
__wf_chain__:[
  {
    "nodeId": "1",
    "actionType": "agent-prompt",
    "label": "Analyze",
    "prompt": "Analyze input",
    "trueChain": [           // ✅ Next step
      {
        "nodeId": "2",
        "actionType": "if-else",
        "label": "Check Type",
        "condition": "input.includes('bug')",
        "trueChain": [       // ✅ TRUE branch
          {
            "nodeId": "3",
            "actionType": "agent-prompt",
            "label": "Bug Response",
            "prompt": "Handle bug"
          }
        ],
        "falseChain": [      // ✅ FALSE branch
          {
            "nodeId": "4",
            "actionType": "agent-prompt",
            "label": "Feature Response",
            "prompt": "Handle feature"
          }
        ]
      }
    ]
  }
]
```

**Execution:**

1. Execute node 1 (Analyze)
2. Execute node 2 (If/Else)
3. Evaluate condition
4. Branch to node 3 OR node 4

## 🔧 Backend Execution Logic

```typescript
async executeStep(step: WorkflowChainStep, context: ExecutionContext) {
  // Execute current step
  const result = await this.executeAgentPrompt(step, context);

  // Handle next step / branching
  if (step.actionType === "if-else") {
    // If/Else: Choose branch based on condition
    const branchTaken = result.metadata?.branchTaken;

    if (branchTaken === "true" && step.trueChain) {
      for (const branchStep of step.trueChain) {
        await this.executeStep(branchStep, context);
      }
    } else if (branchTaken === "false" && step.falseChain) {
      for (const branchStep of step.falseChain) {
        await this.executeStep(branchStep, context);
      }
    }
  } else {
    // Non-If/Else: trueChain is next step in sequence
    if (step.trueChain && step.trueChain.length > 0) {
      const nextStep = step.trueChain[0];
      await this.executeStep(nextStep, context);
    }
  }
}
```

## 📊 Summary Table

| Node Type        | trueChain   | falseChain   |
| ---------------- | ----------- | ------------ |
| **agent-prompt** | Next step   | undefined    |
| **send-message** | Next step   | undefined    |
| **if-else**      | TRUE branch | FALSE branch |
| **supabase-\***  | Next step   | undefined    |

## ✅ Benefits

### **1. Simple Convention:**

- ✅ `trueChain` always means "what's next"
- ✅ For If/Else: "what's next if TRUE"
- ✅ For others: "what's next" (always true)

### **2. Backwards Compatible:**

- ✅ Existing workflows still work
- ✅ No migration needed
- ✅ Backend logic unchanged

### **3. Clear Semantics:**

```typescript
// If/Else node
{
  actionType: "if-else",
  trueChain: [...],   // Next if TRUE
  falseChain: [...]   // Next if FALSE
}

// Other node
{
  actionType: "agent-prompt",
  trueChain: [...]    // Next step (always)
}
```

## 🧪 Testing

### **Test Case 1: Sequential**

```typescript
const chain = [
  {
    nodeId: "1",
    actionType: "agent-prompt",
    trueChain: [{ nodeId: "2" }], // Next step
  },
  {
    nodeId: "2",
    actionType: "agent-prompt",
  },
];

// Execution order: 1 → 2
```

### **Test Case 2: If/Else**

```typescript
const chain = [
  {
    nodeId: "1",
    actionType: "if-else",
    trueChain: [{ nodeId: "2" }], // TRUE branch
    falseChain: [{ nodeId: "3" }], // FALSE branch
  },
];

// If TRUE: 1 → 2
// If FALSE: 1 → 3
```

## 📝 Code Comments

**File:** `ui-next/app/workflows/use-workflows.ts`

```typescript
// Line 61-63: Interface definition
trueChain?: WorkflowChainStep[];  // If/Else: true branch | Other: next step
falseChain?: WorkflowChainStep[]; // If/Else: false branch only

// Line 306-308: Sequential node handling
if (nextStep) {
  // Store next step in trueChain
  // For non-If/Else nodes, trueChain represents the next step in sequence
  step.trueChain = [nextStep];
}
```

## 🎯 Result

**trueChain convention giờ rõ ràng:**

- ✅ **If/Else nodes:** `trueChain` = TRUE branch, `falseChain` = FALSE branch
- ✅ **Other nodes:** `trueChain` = next step in sequence
- ✅ **Simple:** One convention for all nodes
- ✅ **Compatible:** Works with existing backend

**Happy Workflowing! 🔄**
