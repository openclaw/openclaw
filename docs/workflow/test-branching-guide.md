# Testing Workflow Branching Guide

**Date:** March 9, 2026  
**Feature:** If/Else Conditional Branching  
**Status:** Ready for Testing

---

## 🎯 How to Test If/Else Branching

### Step 1: Create Workflow with If/Else

1. **Go to Workflow Editor:**

   ```
   http://127.0.0.1:18789/workflows
   ```

2. **Add Nodes:**
   - Drag "Schedule (Cron)" trigger
   - Drag "AI Agent Prompt" action
   - Drag "If / Else" logic node
   - Drag 2 more "AI Agent Prompt" actions (one for each branch)
   - Drag "Send Message" action

3. **Connect Nodes:**

   ```
   Trigger → Agent1 → If/Else
                          ├─ TRUE (green handle, top) → Agent2 ─┐
                          └─ FALSE (red handle, bottom) → Agent3 ─┘
                                                               ↓
                                                        Send Message
   ```

4. **Connect If/Else Branches:**
   - Click on **GREEN handle** (top-right of If/Else node)
   - Drag to Agent2 node
   - Click on **RED handle** (bottom-right of If/Else node)
   - Drag to Agent3 node

5. **Configure If/Else Condition:**
   - Click on If/Else node
   - Enter condition: `input.length > 100`
   - This means: if output from Agent1 is longer than 100 chars, go TRUE branch

6. **Save Workflow:**
   - Click "💾 Save" button
   - Check console logs (F12) to see chain structure

---

## 🔍 Verify Chain Structure

### Browser Console Logs

After saving, check browser console (F12) for these logs:

```javascript
[WORKFLOW DEBUG] Processing If/Else node: {
  nodeId: "if-else-1",
  outgoingEdgesCount: 2,
  edges: [
    { target: "agent-2", sourceHandle: "true", label: "true" },
    { target: "agent-3", sourceHandle: "false", label: "false" }
  ]
}

[WORKFLOW DEBUG] Added to TRUE branch: agent-2
[WORKFLOW DEBUG] Added to FALSE branch: agent-3

[WORKFLOW DEBUG] Extracted If/Else node: {
  nodeId: "if-else-1",
  hasTrueBranch: true,
  hasFalseBranch: true,
  trueChainLength: 1,
  falseChainLength: 1
}

[WORKFLOW DEBUG] Full chain structure: {
  "nodeId": "agent-1",
  "actionType": "agent-prompt",
  "trueChain": [
    {
      "nodeId": "if-else-1",
      "actionType": "if-else",
      "condition": "input.length > 100",
      "trueChain": [
        {
          "nodeId": "agent-2",
          "actionType": "agent-prompt",
          "trueChain": [...]
        }
      ],
      "falseChain": [
        {
          "nodeId": "agent-3",
          "actionType": "agent-prompt",
          "trueChain": [...]
        }
      ]
    }
  ]
}
```

✅ **Expected:** You should see `trueChain` and `falseChain` arrays populated correctly!

---

## 🚀 Test Execution

### Option 1: Wait for Cron Trigger

1. Set cron expression to `*/1 * * * *` (every minute)
2. Wait for execution
3. Check gateway logs:
   ```bash
   tail -f /tmp/openclaw-gateway.log | grep -i "workflow\|cron\|branch"
   ```

### Option 2: Manual Trigger (Recommended)

Create a test script to manually trigger the workflow:

```bash
# Save as test-workflow.sh
curl -X POST http://127.0.0.1:18789 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "cron.run",
    "params": {
      "jobId": "YOUR_JOB_ID_HERE"
    }
  }'
```

---

## 📊 Backend Execution Logs

Expected logs when workflow executes:

```
cron: starting job execution
cron: parsing workflow chain from description
cron: workflow chain parsed successfully
cron: starting sequential chain execution

# Step 1: Agent 1
cron: [STEP 1/4] STARTING - Node "AI Agent Prompt"
cron: [STEP 1/4] ✅ COMPLETED - Node "AI Agent Prompt"
cron: [STEP 1/4] 📝 OUTPUT - Node "AI Agent Prompt"

# Step 2: If/Else
cron: [STEP 2/4] 🔀 IF/ELSE - Node "If / Else"
cron: branch condition evaluated
cron: condition result: TRUE  (or FALSE depending on input)
cron: ↪️ Executing TRUE branch  (or FALSE branch)

# Step 3: Agent 2 or Agent 3 (depending on branch)
cron: [STEP 3/4] STARTING - Node "AI Agent Prompt"
cron: [STEP 3/4] ✅ COMPLETED - Node "AI Agent Prompt"

# Step 4: Send Message
cron: [STEP 4/4] 📤 SEND-MESSAGE - Node "Send Message"
cron: [STEP 4/4] ✅ DELIVERED - Node "Send Message"

cron: [WORKFLOW COMPLETE] ✅ Chain execution finished
```

---

## ✅ Validation Checklist

### UI/UX

- [ ] If/Else node shows 2 handles (green TRUE, red FALSE)
- [ ] Can connect edges from both handles
- [ ] Edge labels auto-populate based on handle
- [ ] Validation prevents save without 2 labeled edges
- [ ] Condition editor shows helper text

### Chain Extraction

- [ ] Console shows `trueChain` array populated
- [ ] Console shows `falseChain` array populated
- [ ] Both branches include subsequent nodes
- [ ] Nested If/Else works (If/Else inside branch)

### Backend Execution

- [ ] Condition evaluates correctly
- [ ] TRUE branch executes when condition is true
- [ ] FALSE branch executes when condition is false
- [ ] Output passes correctly between steps
- [ ] Both branches can merge to same node

### Edge Cases

- [ ] Empty branch (no nodes) skips gracefully
- [ ] Nested If/Else works
- [ ] Multiple If/Else in same workflow works
- [ ] Condition errors default to FALSE

---

## 🐛 Troubleshooting

### Issue: Can't connect second edge from If/Else

**Solution:** Make sure you're clicking on the correct handle:

- **TRUE handle:** Green, top-right (25% from top)
- **FALSE handle:** Red, bottom-right (75% from top)

### Issue: Validation fails "edges must be labeled"

**Solution:**

1. Click on each edge from If/Else
2. Verify label is "true" for one and "false" for the other
3. Labels are case-insensitive

### Issue: Chain extraction shows empty branches

**Solution:**

1. Check that edges are connected to nodes (not dangling)
2. Verify edge labels match handle IDs
3. Check console for "[WORKFLOW DEBUG] Processing edge" logs

### Issue: Backend doesn't execute branch

**Solution:**

1. Check cron job description contains `__wf_chain__:` prefix
2. Verify JSON structure in description
3. Check logs for "cron: parsing workflow chain" message
4. Look for any parse errors

---

## 📝 Example Workflow JSON

Here's what a complete workflow with If/Else looks like:

```json
{
  "id": "wf-123",
  "name": "Test Branching",
  "nodes": [
    {
      "id": "trigger-1",
      "type": "trigger",
      "data": { "label": "Schedule (Cron)", "cronExpr": "*/1 * * * *" }
    },
    {
      "id": "agent-1",
      "type": "action",
      "data": { "label": "AI Agent Prompt", "prompt": "Analyze: {{input}}" }
    },
    {
      "id": "if-else-1",
      "type": "logic",
      "data": { "label": "If / Else", "condition": "input.length > 100" }
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
    }
  ],
  "edges": [
    { "source": "trigger-1", "target": "agent-1" },
    { "source": "agent-1", "target": "if-else-1" },
    {
      "source": "if-else-1",
      "target": "agent-2",
      "sourceHandle": "true",
      "data": { "label": "true" }
    },
    {
      "source": "if-else-1",
      "target": "agent-3",
      "sourceHandle": "false",
      "data": { "label": "false" }
    }
  ]
}
```

---

## 🎉 Success Criteria

Workflow branching is working correctly when:

1. ✅ UI shows 2 handles on If/Else node
2. ✅ Can connect edges to both handles
3. ✅ Chain extraction creates `trueChain` and `falseChain` arrays
4. ✅ Backend evaluates condition correctly
5. ✅ Correct branch executes based on condition
6. ✅ Output passes through branches correctly

---

**Ready to test! Open http://127.0.0.1:18789/workflows and create your first branching workflow! 🚀**
