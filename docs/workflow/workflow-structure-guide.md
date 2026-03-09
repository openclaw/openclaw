# Workflow Structure Guide

**Date:** March 9, 2026  
**Topic:** Correct Workflow Structure for Branching Support

---

## Structure Requirements

### Basic Sequential Workflow

```json
{
  "nodes": [
    {
      "id": "trigger-1",
      "type": "trigger",
      "data": { "label": "Schedule (Cron)", "cronExpr": "*/5 * * * *" }
    },
    {
      "id": "agent-1",
      "type": "action",
      "data": { "label": "AI Agent Prompt", "prompt": "Hello" }
    },
    {
      "id": "send-1",
      "type": "action",
      "data": { "label": "Send Message", "body": "Done" }
    }
  ],
  "edges": [
    { "source": "trigger-1", "target": "agent-1" },
    { "source": "agent-1", "target": "send-1" }
  ]
}
```

**Extracted Chain:**

```json
[
  {
    "nodeId": "agent-1",
    "actionType": "agent-prompt",
    "prompt": "Hello",
    "trueChain": [
      {
        "nodeId": "send-1",
        "actionType": "send-message",
        "body": "Done",
        "trueChain": []
      }
    ]
  }
]
```

---

### Workflow with If/Else Branching

```json
{
  "nodes": [
    {
      "id": "trigger-1",
      "type": "trigger",
      "data": { "label": "Schedule (Cron)" }
    },
    {
      "id": "agent-1",
      "type": "action",
      "data": { "label": "AI Agent Prompt", "prompt": "Analyze: {{input}}" }
    },
    {
      "id": "if-else-1",
      "type": "logic",
      "data": {
        "label": "If / Else",
        "condition": "input.length > 100"
      }
    },
    {
      "id": "agent-2",
      "type": "action",
      "data": { "label": "AI Agent Prompt", "prompt": "Detailed: {{input}}" }
    },
    {
      "id": "agent-3",
      "type": "action",
      "data": { "label": "AI Agent Prompt", "prompt": "Brief: {{input}}" }
    },
    {
      "id": "send-1",
      "type": "action",
      "data": { "label": "Send Message" }
    }
  ],
  "edges": [
    { "source": "trigger-1", "target": "agent-1" },
    { "source": "agent-1", "target": "if-else-1" },
    {
      "source": "if-else-1",
      "target": "agent-2",
      "data": { "label": "true" }
    },
    {
      "source": "if-else-1",
      "target": "agent-3",
      "data": { "label": "false" }
    },
    { "source": "agent-2", "target": "send-1" },
    { "source": "agent-3", "target": "send-1" }
  ]
}
```

**Extracted Chain:**

```json
[
  {
    "nodeId": "agent-1",
    "actionType": "agent-prompt",
    "prompt": "Analyze: {{input}}",
    "trueChain": [
      {
        "nodeId": "if-else-1",
        "actionType": "if-else",
        "condition": "input.length > 100",
        "trueChain": [
          {
            "nodeId": "agent-2",
            "actionType": "agent-prompt",
            "prompt": "Detailed: {{input}}",
            "trueChain": [
              {
                "nodeId": "send-1",
                "actionType": "send-message",
                "trueChain": []
              }
            ]
          }
        ],
        "falseChain": [
          {
            "nodeId": "agent-3",
            "actionType": "agent-prompt",
            "prompt": "Brief: {{input}}",
            "trueChain": [
              {
                "nodeId": "send-1",
                "actionType": "send-message",
                "trueChain": []
              }
            ]
          }
        ]
      }
    ]
  }
]
```

---

## Edge Labeling Rules

### For If/Else Nodes

Edges from If/Else nodes **MUST** be labeled:

```typescript
// In React Flow edge data
{
  source: "if-else-1",
  target: "agent-2",
  data: { label: "true" }  // or "yes"
}

{
  source: "if-else-1",
  target: "agent-3",
  data: { label: "false" }  // or "no"
}
```

### Supported Labels

| Label     | Meaning              |
| --------- | -------------------- |
| `"true"`  | TRUE branch          |
| `"yes"`   | TRUE branch (alias)  |
| `"false"` | FALSE branch         |
| `"no"`    | FALSE branch (alias) |

### Fallback Behavior

If edges are NOT labeled:

- **First edge** → TRUE branch
- **Second edge** → FALSE branch

**But this is unreliable!** Always label edges explicitly.

---

## How to Label Edges in React Flow

### Option 1: Edge Component with Label Input

```tsx
// In workflow-editor.tsx
const onEdgeClick = useCallback(
  (event: React.MouseEvent, edge: Edge) => {
    const label = prompt("Enter edge label (true/false):");
    if (label) {
      setEdges((eds) => eds.map((e) => (e.id === edge.id ? { ...e, data: { label } } : e)));
    }
  },
  [setEdges],
);

<ReactFlow
  onEdgeClick={onEdgeClick}
  // ...
/>;
```

### Option 2: Custom Edge Type with Dropdown

```tsx
// custom-edge.tsx
export function BranchEdge({ id, data, markerEnd }: EdgeProps) {
  const { setEdges } = useReactFlow();

  const onLabelChange = (e: React.ChangeEvent<HTMLSelect>) => {
    setEdges((eds) =>
      eds.map((edge) => (edge.id === id ? { ...edge, data: { label: e.target.value } } : edge)),
    );
  };

  return (
    <>
      <BaseEdge path={getPath()} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div className="edge-label-dropdown">
          <select value={data?.label || ""} onChange={onLabelChange}>
            <option value="">Select...</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
```

---

## Validation Rules

### Before Save

Check these constraints:

1. **If/Else must have 2 outgoing edges**

   ```typescript
   const ifElseNodes = nodes.filter((n) => n.data?.label === "If / Else");
   for (const node of ifElseNodes) {
     const outgoingEdges = edges.filter((e) => e.source === node.id);
     if (outgoingEdges.length !== 2) {
       alert(`If/Else node "${node.id}" must have exactly 2 outgoing edges`);
       return false;
     }
   }
   ```

2. **Edges from If/Else must be labeled**

   ```typescript
   for (const edge of outgoingEdges) {
     const label = edge.data?.label || edge.label;
     if (!label || !["true", "false"].includes(label.toLowerCase())) {
       alert(`Edge from If/Else must be labeled "true" or "false"`);
       return false;
     }
   }
   ```

3. **No cycles in workflow**
   ```typescript
   function hasCycle(nodeId: string, visited: Set<string>): boolean {
     if (visited.has(nodeId)) return true;
     visited.add(nodeId);
     const outgoing = edges.filter((e) => e.source === nodeId);
     for (const edge of outgoing) {
       if (hasCycle(edge.target, new Set(visited))) return true;
     }
     return false;
   }
   ```

---

## Common Mistakes

### ❌ Mistake 1: Unlabeled Branches

```json
// WRONG - Edges not labeled
{
  "edges": [
    { "source": "if-else-1", "target": "agent-2" },
    { "source": "if-else-1", "target": "agent-3" }
  ]
}
```

**Fix:**

```json
{
  "edges": [
    {
      "source": "if-else-1",
      "target": "agent-2",
      "data": { "label": "true" }
    },
    {
      "source": "if-else-1",
      "target": "agent-3",
      "data": { "label": "false" }
    }
  ]
}
```

### ❌ Mistake 2: Both Edges Labeled "true"

```json
// WRONG - Both edges same label
{
  "edges": [
    { "source": "if-else-1", "target": "agent-2", "data": { "label": "true" } },
    { "source": "if-else-1", "target": "agent-3", "data": { "label": "true" } }
  ]
}
```

**Fix:** Label one "true" and one "false"

### ❌ Mistake 3: If/Else with Only 1 Branch

```json
// WRONG - Missing false branch
{
  "nodes": [{ "id": "if-else-1", "type": "logic", "data": { "label": "If / Else" } }],
  "edges": [{ "source": "if-else-1", "target": "agent-2", "data": { "label": "true" } }]
}
```

**Fix:** Add false branch (can be empty if you want to skip)

---

## Testing Your Structure

### Debug Script

Run this in browser console after creating workflow:

```javascript
// Get current workflow state
const workflow = {
  nodes: [...nodes],
  edges: [...edges],
};

// Check If/Else nodes
const ifElseNodes = workflow.nodes.filter((n) => n.data?.label === "If / Else");
console.log("If/Else nodes:", ifElseNodes.length);

for (const node of ifElseNodes) {
  const outgoingEdges = workflow.edges.filter((e) => e.source === node.id);
  console.log(`Node ${node.id}:`);
  console.log(`  - Outgoing edges: ${outgoingEdges.length}`);
  console.log(`  - Labels: ${outgoingEdges.map((e) => e.data?.label || "UNLABELED").join(", ")}`);
}

// Test extraction
const chain = extractChainFromTrigger("trigger-1", nodes, edges);
console.log("Extracted chain:", JSON.stringify(chain, null, 2));
```

---

## Summary

### ✅ Correct Structure Checklist

- [ ] If/Else nodes have exactly 2 outgoing edges
- [ ] Each edge from If/Else is labeled "true" or "false"
- [ ] Sequential nodes have at most 1 outgoing edge
- [ ] No cycles in the graph
- [ ] All nodes are reachable from trigger
- [ ] Chain extraction logs show correct trueChain/falseChain

### 📊 Structure Comparison

| Aspect          | Sequential      | With Branching            |
| --------------- | --------------- | ------------------------- |
| Node types      | Trigger, Action | + Logic                   |
| Edges per node  | 1               | 1 (Action) or 2 (If/Else) |
| Edge labels     | Optional        | Required for If/Else      |
| Chain structure | Linear array    | Nested tree               |
| Execution flow  | Top → Bottom    | Conditional branches      |

---

**Last Updated:** 2026-03-09
