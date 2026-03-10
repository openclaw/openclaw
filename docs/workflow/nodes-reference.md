# Workflow Nodes Reference

**Last Updated:** March 9, 2026
**Version:** 2.0 (Modular Architecture)

---

## Overview

OpenClaw workflows are built from **nodes** connected in a directed graph. Each node performs a specific action, and edges define the execution flow.

### Node Categories

| Category            | Color     | Description                |
| ------------------- | --------- | -------------------------- |
| **Triggers**        | 🟢 Green  | Start workflow execution   |
| **Actions**         | 🟣 Purple | Perform operations         |
| **Logic & Control** | 🟠 Orange | Control flow and branching |

---

## Triggers

Triggers initiate workflow execution.

### ⏱️ Schedule (Cron)

Run workflow on a cron schedule.

**Configuration:**

- **Cron Expression:** Standard cron format (e.g., `*/5 * * * *`)

**Examples:**

```
*/5 * * * *    # Every 5 minutes
0 * * * *      # Every hour
0 9 * * 1-5    # Weekdays at 9 AM
0 0 * * *      # Daily at midnight
```

**Use Cases:**

- Periodic data collection
- Scheduled reports
- Regular health checks

---

### 💬 Chat Message

Trigger workflow when a chat message is received.

**Configuration:**

- **Target Session Key:** Session to monitor
- **Match Keyword:** (Optional) Only trigger if message contains this text

**Use Cases:**

- Auto-responses to specific keywords
- Message routing
- Chat-based automation

---

## Actions

Actions perform operations in your workflow.

### 🧠 AI Agent Prompt

Call an AI agent with a prompt and get a response.

**Configuration:**

- **Agent ID:** (Optional) Specific agent to use
- **Prompt Template:** Text with `{{input}}` placeholder

**Template Variables:**

- `{{input}}` - Output from previous step
- `{{variables.name}}` - Custom workflow variables

**Example:**

```
Analyze this data and identify key trends: {{input}}
```

**Output:**

- AI response text (passed to next node)

**Use Cases:**

- Data analysis
- Content generation
- Classification tasks

---

### 📤 Send Message

Send a message to a channel.

**Configuration:**

- **Channel:** Target channel type
  - Slack
  - Discord
  - Telegram
  - WhatsApp
  - LINE
  - SMS
  - Facebook Messenger
- **Recipient ID:** User/channel ID or @mention
- **Account:** (Optional) Specific account for multi-account setups
- **Message Body:** Message text with `{{input}}` support

**Example:**

```
Hello! Here's the analysis: {{input}}
```

**Output:**

- Passes through previous input unchanged

**Use Cases:**

- Notifications
- Report delivery
- Auto-responses

---

### 🛠️ Execute Tool

Execute a tool from the catalog.

**Configuration:**

- **Tool Name:** Tool identifier (e.g., `browser.navigate`, `file.read`)
- **Tool Arguments:** JSON object with tool parameters

**Example:**

```json
{
  "url": "https://example.com",
  "timeout": 30000
}
```

**Status:** ⚠️ Coming Soon

**Use Cases:**

- Web browsing
- File operations
- API calls

---

### 💻 Remote Invoke

Execute a command on a paired node device.

**Configuration:**

- **Target Node:** Device to execute on
  - macOS (Local)
  - iOS Device
  - Android Device
- **Command:** Node command (e.g., `camera.snap`, `system.run`)
- **Command Params:** JSON object with command parameters

**Example:**

```json
{
  "facing": "front",
  "duration": 5000
}
```

**Status:** ⚠️ Coming Soon

**Use Cases:**

- Remote camera capture
- Screen recording
- Device control

---

### 🗣️ Speak (TTS)

Convert text to speech.

**Configuration:**

- **Text to Speak:** Text with `{{input}}` support
- **Voice:** Voice selection
  - Rachel (Professional)
  - Adam (Deep)
  - Bella (British)
  - Josh (American)
- **Provider:** TTS service
  - ElevenLabs
  - OpenAI
  - Azure TTS

**Status:** ⚠️ Coming Soon

**Use Cases:**

- Voice notifications
- Audio content generation
- Accessibility features

---

## Logic & Control

Control flow and conditional execution.

### 🔀 If / Else

Branch execution based on a condition.

**Configuration:**

- **Condition Expression:** JavaScript-like expression

**Available Variables:**

- `input` - Output from previous step
- `variables` - Custom workflow variables

**Helper Functions:**

- `input.includes('text')` - Check if contains text
- `input.startsWith('...')` - Check prefix
- `input.endsWith('...')` - Check suffix
- `input.length` - Get length
- `input.length > 50` - Compare length
- `variables.myVar === 'value'` - Check variable

**Condition Examples:**

```javascript
// String matching
input.includes("urgent");
input.toLowerCase().includes("error");

// Length checks
input.length > 100;
input.length < 10;

// Multiple conditions
input.includes("error") || input.includes("critical");
input.includes("HOT") && input.length > 50;

// Pattern matching
input.includes("@") && input.includes(".");
input.startsWith("http");
```

**Branches:**

- **TRUE Branch:** Executed when condition is true
- **FALSE Branch:** Executed when condition is false

**Output:**

- Passes through input unchanged
- Branch selection determines which chain executes

**Use Cases:**

- Conditional routing
- Error handling
- Content filtering

---

### ⏳ Delay

Wait for a specified duration before continuing.

**Configuration:**

- **Duration (milliseconds):** Wait time

**Common Values:**

- `1000` - 1 second
- `5000` - 5 seconds
- `60000` - 1 minute
- `300000` - 5 minutes (max: 5 minutes)

**Output:**

- Passes through input unchanged

**Use Cases:**

- Rate limiting
- Waiting for external events
- Pacing operations

---

### 📝 Custom JS

Execute custom JavaScript code to transform data.

**Configuration:**

- **JavaScript Code:** Code to execute

**Available Variables:**

- `input` - Output from previous step
- `variables` - Custom workflow variables

**Example:**

```javascript
// Transform input data
const transformed = input.toUpperCase();
return `Processed: ${transformed}`;
```

**Status:** ⚠️ Security Review Required

**Use Cases:**

- Data transformation
- Custom formatting
- Complex calculations

---

## Node Configuration

### Common Fields

All nodes support:

- **Node Label:** Display name
- **Description:** Optional description

### Data Flow

```
Trigger → Node 1 → Node 2 → If/Else → Node 3a/3b → Node 4
   ↓         ↓         ↓           ↓          ↓          ↓
 start    agent    send      condition   true/false   finish
         prompt   message
```

### Template Syntax

Use `{{...}}` in text fields:

- `{{input}}` - Previous node's output
- `{{variables.name}}` - Workflow variable

---

## Best Practices

### 1. Keep Conditions Simple

✅ **Good:**

```javascript
input.includes("urgent");
```

❌ **Bad:**

```javascript
// Too complex - move logic to Agent node instead
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

- Connect to a "log" node, or
- Leave empty but document why

### 4. Test Both Paths

- Test with TRUE condition input
- Test with FALSE condition input
- Verify both branches work correctly

### 5. Document Complex Workflows

Add comments in workflow name or description:

```
"Customer Support Router (urgent → immediate, normal → 24h)"
```

---

## Troubleshooting

### Node Not Executing

1. Check node is connected to trigger
2. Verify no cycles in workflow
3. Check previous nodes completed successfully

### If/Else Not Branching

1. Verify condition expression is valid
2. Check edge labels ("true"/"false")
3. Ensure both branches are connected

### Template Not Rendering

1. Check `{{input}}` syntax (no spaces)
2. Verify previous node produced output
3. Check variable names match exactly

---

## Related Documentation

- **Architecture:** [`/src/gateway/workflow-nodes/README.md`](https://github.com/openclaw/openclaw/blob/main/src/gateway/workflow-nodes/README.md)
- **Implementation:** [`docs/workflow/WORKFLOW_NODES_IMPLEMENTATION.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/WORKFLOW_NODES_IMPLEMENTATION.md)
- **Examples:** [`docs/workflow/if-else-examples.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/if-else-examples.md)
- **Structure Guide:** [`docs/workflow/workflow-structure-guide.md`](https://github.com/openclaw/openclaw/blob/main/docs/workflow/workflow-structure-guide.md)

---

## Changelog

### Version 2.0 (March 9, 2026)

- ✅ Refactored to modular node architecture
- ✅ Added Execute Tool node
- ✅ Added Remote Invoke node
- ✅ Added Speak (TTS) node
- ✅ Added Delay node
- ✅ Added Custom JS node
- ✅ Improved If/Else branching support
- ✅ Updated UI configuration panels

### Version 1.0

- Initial workflow system
- Basic agent-prompt and send-message nodes
- Simple If/Else support
