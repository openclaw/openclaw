# If/Else Workflow Examples

**3 Complete Examples** with If/Else branching to learn workflow patterns!

**Last Updated:** March 9, 2026

---

## 📋 Example 1: Customer Support Auto-Response

**Use Case:** Automatically classify and respond to customer messages based on urgency.

### 🎯 Workflow Flow

```
┌─────────────┐
│ ⏱️ Schedule │ Every 5 minutes
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ 🧠 Agent 1      │ "Analyze & classify as urgent or normal"
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ 🔀 If / Else    │ Condition: input.includes('urgent')
└──────┬──────────┴──────┐
       │ TRUE            │ FALSE
       ▼                 ▼
┌─────────────┐   ┌─────────────┐
│ 🧠 Agent 2  │   │ 🧠 Agent 3  │
│ Urgent      │   │ Normal      │
│ Response    │   │ Response    │
└──────┬──────┘   └──────┬──────┘
       │                 │
       └────────┬────────┘
                ▼
        ┌───────────────┐
        │ 📤 Send Msg   │ Post to #customer-support
        └───────────────┘
```

### 🔧 Configuration

**If/Else Condition:**

```javascript
input.toLowerCase().includes("urgent");
```

**TRUE Branch (Urgent):**

- Draft immediate response
- Apologize and prioritize
- Provide ticket: URGENT-12345
- Promise 1-hour response

**FALSE Branch (Normal):**

- Friendly helpful response
- Reference: NORM-12345
- Standard response time

### 📊 Expected Output

**If message contains "urgent":**

```
🚨 URGENT Response:
Dear Customer,
We understand this is urgent and apologize for the inconvenience.
Ticket: URGENT-1709982341
Someone will contact you within 1 hour.
```

**If message is normal:**

```
📋 Normal Response:
Dear Customer,
Thank you for reaching out! We're happy to help.
Reference: NORM-1709982341
Best regards, Support Team
```

---

## 📋 Example 2: Smart Alert Router

**Use Case:** Route system alerts based on severity.

### 🎯 Workflow Flow

```
┌─────────────┐
│ ⏱️ Schedule │ Every 2 hours
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ 🧠 Agent 1      │ "Check system status"
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ 🔀 If / Else    │ Condition: includes('down' OR 'critical' OR 'error')
└──────┬──────────┴──────────┐
       │ TRUE                │ FALSE
       ▼                     ▼
┌─────────────┐       ┌─────────────┐
│ 🧠 Agent 2  │       │ 🧠 Agent 3  │
│ Critical    │       │ Normal Log  │
│ Alert       │       │ Entry       │
└──────┬──────┘       └──────┬──────┘
       │                     │
       ▼                     ▼
┌──────────────┐     ┌──────────────┐
│ 📤 Send Msg  │     │ 📤 Send Msg  │
│ #oncall-alerts│    │ #system-logs │
│ @channel     │     │ Info only    │
└──────────────┘     └──────────────┘
```

### 🔧 Configuration

**If/Else Condition:**

```javascript
input.toLowerCase().includes("down") ||
  input.toLowerCase().includes("critical") ||
  input.toLowerCase().includes("error");
```

**TRUE Branch (Critical):**

- Create urgent alert
- Tag @channel
- Send to #oncall-alerts
- Include action items

**FALSE Branch (Normal):**

- Create log summary
- Info only
- Send to #system-logs
- No immediate action needed

### 📊 Expected Output

**If system has issues:**

```
🚨 CRITICAL SYSTEM ALERT

Issues detected:
- API server DOWN
- Error rate: 45%
- Response time: 5000ms

@channel Please investigate immediately!
```

**If system is healthy:**

```
📋 System Status Log

✅ All systems operational
✅ Response time: 150ms
✅ Error rate: 0.1%

All systems operational.
```

---

## 📋 Example 3: Lead Qualification Bot

**Use Case:** Score and route sales leads by temperature.

### 🎯 Workflow Flow

```
┌─────────────┐
│ ⏱️ Schedule │ Weekdays 9 AM
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ 🧠 Agent 1      │ "Score leads: HOT/WARM/COLD"
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ 🔀 If / Else    │ Condition: includes('HOT')
└──────┬──────────┴──────────┐
       │ TRUE                │ FALSE
       ▼                     ▼
┌─────────────┐       ┌─────────────┐
│ 🧠 Agent 2  │       │ 🧠 Agent 3  │
│ Hot Lead    │       │ Warm/Cold   │
│ Outreach    │       │ Nurture     │
└──────┬──────┘       └──────┬──────┘
       │                     │
       ▼                     ▼
┌──────────────┐     ┌──────────────┐
│ 📤 Send Msg  │     │ 📤 Send Msg  │
│ #sales-hot  │     │ #sales-nurture│
│ Contact NOW!│     │ Weekly sequence│
└──────────────┘     └──────────────┘
```

### 🔧 Configuration

**If/Else Condition:**

```javascript
input.toUpperCase().includes("HOT");
```

**TRUE Branch (Hot Leads):**

- Personalized outreach
- Propose call within 24h
- Include calendar link
- Tag sales team

**FALSE Branch (Warm/Cold):**

- Nurture email template
- Provide resources
- Invite to webinar
- Non-pushy approach

### 📊 Expected Output

**If HOT lead found:**

```
🔥 HOT LEADS - Contact Within 24 Hours!

Lead: John Smith, Acme Corp
Budget: $15,000
Timeline: ASAP
Score: HOT

Personalized message:
"Hi John, noticed you're looking for immediate solution...
[Calendar link]
Let's schedule a call today!"

@sales-team Drop everything and reach out NOW!
```

**If WARM/COLD leads:**

```
🌱 Lead Nurturing Campaign

Hi [Name],
Thanks for your interest!
Here's our helpful guide: [link]
Join our next webinar: [link]
We're here when you're ready!

Add these to the weekly nurture sequence.
```

---

## 🎨 Visual Node Layout

### How to Arrange Nodes in Editor

```
Screen Layout (Left to Right):

Y=100                      HOT/TRUE Branch
         ┌────────┐  ┌──────────┐  ┌─────────┐
         │ Agent  │  │  TRUE    │  │  Send   │
         │   2    │◄─┤  Branch  │◄─┤  Msg 1  │
         └────────┘  └──────────┘  └─────────┘
                          ▲
Y=200  ┌─────┐  ┌─────┐  │  ┌──────────┐  ┌─────────┐
       │Trigger├─►Agent├─┴─►│ If / Else│◄─┤  Send   │
       └─────┘  └─────┘     └──────────┘  │  Msg 2  │
                          │               └─────────┘
Y=300                      └──────────────►│
         ┌────────┐  ┌──────────┐          │
         │ Agent  │  │  FALSE   │◄─────────┘
         │   3    │◄─┤  Branch  │
         └────────┘  └──────────┘
                      COLD/FALSE Branch
```

### Connection Guide

**For If/Else node:**

1. **TRUE Handle (Green, Top-Right):**
   - Click green dot
   - Drag to next node in TRUE path
   - Auto-labels "true"

2. **FALSE Handle (Red, Bottom-Right):**
   - Click red dot
   - Drag to next node in FALSE path
   - Auto-labels "false"

---

## 🔧 Condition Examples

### String Matching

```javascript
// Contains word
input.includes("urgent");

// Case insensitive
input.toLowerCase().includes("urgent");

// Starts with
input.startsWith("ERROR:");

// Ends with
input.endsWith("!");
```

### Length Checks

```javascript
// Too long
input.length > 500;

// Too short
input.length < 10;

// Just right
input.length > 50 && input.length < 200;
```

### Multiple Conditions

```javascript
// OR conditions
input.includes("error") || input.includes("critical");

// AND conditions
input.includes("urgent") &&
  input.length >
    100(
      // Complex
      input.includes("HOT") || input.includes("urgent"),
    ) &&
  !input.includes("spam");
```

### Pattern Matching

```javascript
// Email format
input.includes("@") && input.includes(".");

// Phone number
input.match(/\d{3}-\d{4}/);

// URL
input.startsWith("http");
```

---

## 🧪 Testing Your Workflow

### Step 1: Create Workflow

1. Open Workflow Editor
2. Drag nodes from palette
3. Connect nodes with edges
4. Configure each node
5. Label If/Else edges

### Step 2: Check Console Logs

Open browser DevTools (F12) and look for:

```javascript
[WORKFLOW DEBUG] Processing If/Else node: {
  nodeId: "if-else-1",
  outgoingEdgesCount: 2,
  edges: [...]
}

[WORKFLOW DEBUG] Added to TRUE branch: agent-2
[WORKFLOW DEBUG] Added to FALSE branch: agent-3

[WORKFLOW DEBUG] Full chain structure: {
  "trueChain": [...],
  "falseChain": [...]
}
```

### Step 3: Monitor Execution

```bash
# Watch gateway logs
tail -f /tmp/openclaw-gateway.log | grep -i "workflow\|branch\|if-else"
```

**Expected logs:**

```
workflow: executing chain step
workflow: node execution complete
workflow: branch condition evaluated
workflow: branch taken, executing branch chain
workflow: chain execution complete
```

---

## ✅ Best Practices

### 1. Keep Conditions Simple

✅ **Good:**

```javascript
input.includes("urgent");
```

❌ **Bad:**

```javascript
// Too complex, move to Agent instead
input
  .split(" ")
  .filter((w) => w.length > 5)
  .map((w) => w.charCodeAt(0))
  .reduce((a, b) => a + b) > 1000;
```

### 2. Use Descriptive Labels

✅ **Good:**

- TRUE Label: "Urgent Messages"
- FALSE Label: "Normal Messages"

❌ **Bad:**

- TRUE Label: "Yes"
- FALSE Label: "No"

### 3. Handle Empty Branches

If one branch has no actions:

- Still connect to a "log" node
- Or leave empty but document why

### 4. Test Both Paths

- Manually trigger with TRUE condition input
- Manually trigger with FALSE condition input
- Verify both branches work

### 5. Document Conditions

Add comments in workflow name or description:

```
"Customer Support Router (urgent → immediate, normal → 24h)"
```

---

## 🎓 Next Steps

After mastering basic If/Else:

1. **Nested If/Else:** If/Else inside branches
2. **Multiple If/Else:** Chain multiple conditions
3. **Merge Branches:** Both branches converge to same node
4. **Complex Conditions:** Use Agent to pre-process before If/Else
5. **Delay Nodes:** Add pauses between steps
6. **Multiple Actions:** Chain several actions per branch

---

## 📚 Related Documentation

- **Nodes Reference:** [`docs/workflow/nodes-reference.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/nodes-reference.md)
- **Structure Guide:** [`docs/workflow/workflow-structure-guide.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/workflow-structure-guide.md)
- **Implementation:** [`docs/workflow/WORKFLOW_NODES_IMPLEMENTATION.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/WORKFLOW_NODES_IMPLEMENTATION.md)

---

**Ready to build! Copy these examples and customize for your use case! 🚀**
