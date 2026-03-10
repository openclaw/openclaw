# Workflow Structure Guide

**Last Updated:** March 9, 2026
**Version:** 2.0

---

## Overview

This guide covers the correct structure for OpenClaw workflows, including sequential execution and If/Else branching.

---

## Basic Sequential Workflow

A simple linear workflow:

```json
{
  "nodes": [
    {
      "id": "trigger-1",
      "type": "trigger",
      "data": {
        "label": "Schedule (Cron)",
        "cronExpr": "*/5 * * * *"
      }
    },
    {
      "id": "agent-1",
      "type": "action",
      "data": {
        "label": "AI Agent Prompt",
        "prompt": "Analyze: {{input}}"
      }
    },
    {
      "id": "send-1",
      "type": "action",
      "data": {
        "label": "Send Message",
        "body": "Done: {{input}}"
      }
    }
  ],
  "edges": [
    { "source": "trigger-1", "target": "agent-1" },
    { "source": "agent-1", "target": "send-1" }
  ]
}
```

**Execution Flow:**

```
Trigger → Agent Prompt → Send Message
   ↓          ↓              ↓
  cron    analyze        deliver
```

---

## Workflow with If/Else Branching

Conditional execution based on input:

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
      "data": {
        "label": "AI Agent Prompt",
        "prompt": "Analyze: {{input}}"
      }
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
      "data": {
        "label": "AI Agent Prompt",
        "prompt": "Detailed analysis: {{input}}"
      }
    },
    {
      "id": "agent-3",
      "type": "action",
      "data": {
        "label": "AI Agent Prompt",
        "prompt": "Brief summary: {{input}}"
      }
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

**Execution Flow:**

```
                    TRUE branch
                 ↗ (length > 100)
                /   → Agent 2 ─┐
Trigger → Agent 1 → If/Else    → Send
                \   → Agent 3 ─┘
                 ↘ (length ≤ 100)
                  FALSE branch
```

---

## Edge Labeling Rules

### For If/Else Nodes

Edges from If/Else nodes **MUST** be labeled:

```typescript
// TRUE branch
{
  source: "if-else-1",
  target: "agent-2",
  data: { label: "true" }  // or "yes"
}

// FALSE branch
{
  source: "if-else-1",
  target: "agent-3",
  data: { label: "false" }  // or "no"
}
```

### Supported Labels

| Label     | Meaning              | Handle Color |
| --------- | -------------------- | ------------ |
| `"true"`  | TRUE branch          | 🟢 Green     |
| `"yes"`   | TRUE branch (alias)  | 🟢 Green     |
| `"false"` | FALSE branch         | 🔴 Red       |
| `"no"`    | FALSE branch (alias) | 🔴 Red       |

### Fallback Behavior

⚠️ **Warning:** If edges are NOT labeled:

- **First edge** → TRUE branch
- **Second edge** → FALSE branch

**This is unreliable!** Always label edges explicitly.

---

## Validation Rules

### Before Save

The workflow editor validates:

#### 1. If/Else Must Have 2 Outgoing Edges

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

#### 2. Edges from If/Else Must Be Labeled

```typescript
for (const edge of outgoingEdges) {
  const label = edge.data?.label || edge.label;
  if (!label || !["true", "false", "yes", "no"].includes(label.toLowerCase())) {
    alert(`Edge from If/Else must be labeled "true" or "false"`);
    return false;
  }
}
```

#### 3. No Cycles in Workflow

```typescript
function hasCycle(nodeId: string, visited: Set<string>, path: Set<string>): boolean {
  if (path.has(nodeId)) return true;
  if (visited.has(nodeId)) return false;

  visited.add(nodeId);
  path.add(nodeId);

  const outgoing = edges.filter((e) => e.source === nodeId);
  for (const edge of outgoing) {
    if (hasCycle(edge.target, visited, path)) return true;
  }

  path.delete(nodeId);
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

**✅ Fix:**

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

---

### ❌ Mistake 2: Both Edges Same Label

```json
// WRONG - Both edges labeled "true"
{
  "edges": [
    { "source": "if-else-1", "target": "agent-2", "data": { "label": "true" } },
    { "source": "if-else-1", "target": "agent-3", "data": { "label": "true" } }
  ]
}
```

**✅ Fix:** Label one "true" and one "false"

---

### ❌ Mistake 3: If/Else with Only 1 Branch

```json
// WRONG - Missing false branch
{
  "nodes": [{ "id": "if-else-1", "type": "logic" }],
  "edges": [{ "source": "if-else-1", "target": "agent-2", "data": { "label": "true" } }]
}
```

**✅ Fix:** Add false branch (can be empty if you want to skip)

---

## Testing Your Workflow

### Debug in Browser Console

After creating your workflow:

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

// Test chain extraction
const chain = extractChainFromTrigger("trigger-1", nodes, edges);
console.log("Extracted chain:", JSON.stringify(chain, null, 2));
```

### Monitor Gateway Logs

```bash
# Watch workflow execution
tail -f /tmp/openclaw-gateway.log | grep -i "workflow\|branch\|if-else"
```

**Expected logs:**

```
workflow: executing chain step
workflow: node execution complete
workflow: branch taken, executing branch chain
workflow: chain execution complete
```

---

## Visual Layout Tips

### Recommended Node Arrangement

```
Left to Right Flow:

Y=100                 TRUE Branch
       ┌────────┐  ┌──────────┐  ┌─────────┐
       │Trigger │→ │ Agent 1  │→ │  Send   │
       └────────┘  └──────────┘  └─────────┘
                        ↓
Y=200              ┌─────────┐
                   │If / Else│
                   └─────────┘
                        ↓
Y=300                 FALSE Branch
       ┌────────┐  ┌──────────┐  ┌─────────┐
       │ Agent 2│← │  Branch  │← │ Agent 3 │
       └────────┘  └──────────┘  └─────────┘
```

### Handle Colors

- **Green (Top-Right):** TRUE branch
- **Red (Bottom-Right):** FALSE branch

---

## Summary Checklist

### ✅ Valid Workflow Structure

- [ ] If/Else nodes have exactly 2 outgoing edges
- [ ] Each edge from If/Else is labeled "true" or "false"
- [ ] Sequential nodes have at most 1 outgoing edge
- [ ] No cycles in the graph
- [ ] All nodes are reachable from trigger
- [ ] Chain extraction shows correct trueChain/falseChain

### 📊 Structure Comparison

| Aspect          | Sequential      | With Branching            |
| --------------- | --------------- | ------------------------- |
| Node types      | Trigger, Action | + Logic                   |
| Edges per node  | 1               | 1 (Action) or 2 (If/Else) |
| Edge labels     | Optional        | Required for If/Else      |
| Chain structure | Linear array    | Nested tree               |
| Execution flow  | Top → Bottom    | Conditional branches      |

---

## Related Documentation

- **Nodes Reference:** [`docs/workflow/nodes-reference.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/nodes-reference.md)
- **If/Else Examples:** [`docs/workflow/if-else-examples.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/if-else-examples.md)
- **Implementation:** [`docs/workflow/WORKFLOW_NODES_IMPLEMENTATION.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/WORKFLOW_NODES_IMPLEMENTATION.md)
- **Architecture:** [`src/gateway/workflow-nodes/README.md`](https://github.com/openclaw/openclaw/blob/main/src/gateway/workflow-nodes/README.md)

---

**Version:** 2.0 (Modular Architecture)
**Last Updated:** March 9, 2026
