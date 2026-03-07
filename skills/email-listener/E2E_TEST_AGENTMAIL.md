# End-to-End Test: Real Email via AgentMail

**Objective**: Send a real email to Tim's AgentMail inbox and verify the complete intent parser flow:
Email → Intent Parser → Task Creation → Response Email via AgentMail

---

## Prerequisites

### 1. AgentMail API Key
You already have this from yesterday. Set it as environment variable:
```bash
export AGENTMAIL_API_KEY="your-key-here"
```

### 2. Tim's AgentMail Inbox
Tim's inbox address: `timsmail@agentmail.to` (or similar based on setup)

Allowlisted recipients for responses:
- fjventura20@gmail.com
- fjventura20@outlook.com

### 3. Anthropic API Key
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## How AgentMail Integration Works

```
Regular Email Account
    ↓ (sends email to Tim)
Tim's AgentMail Inbox (timsmail@agentmail.to)
    ↓ (email listener reads via AgentMail API)
Email Listener Skill
    ↓ (parseIntent using Claude Haiku)
Intent Parser (CREATE_TASK, STATUS, PING, etc.)
    ↓ (execute command)
Task Created + Response Email
    ↓ (send via AgentMail API)
Original Sender's Inbox
```

---

## Step 1: Integrate AgentMail with Email Listener

The current email-listener skill is IMAP-based. To use AgentMail, we need to integrate it:

### Option A: Modify Email Listener to Use AgentMail API

**File**: `skills/email-listener/src/index.ts`

Replace IMAP polling with AgentMail API polling:

```typescript
// Instead of IMAP polling, use AgentMail API
async function pollInboxViaAgentMail(): Promise<ParsedEmail[]> {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    throw new Error("AGENTMAIL_API_KEY not set");
  }

  try {
    // Get inbox messages via AgentMail API
    const response = await fetch(
      'https://api.agentmail.to/v0/inboxes/timsmail@agentmail.to/messages',
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    );

    const messages = await response.json();

    // Parse to ParsedEmail format
    return messages.map((msg: any) => ({
      messageId: msg.message_id,
      sender: msg.from.email,
      senderName: msg.from.name || msg.from.email,
      subject: msg.subject,
      body: msg.text || msg.html,
      timestamp: new Date(msg.date),
    }));
  } catch (error) {
    logger.error("Failed to poll AgentMail inbox", { error: String(error) });
    return [];
  }
}
```

**Update polling function**:
```typescript
async function poll(): Promise<void> {
  if (!config) return;

  try {
    logger.debug("Polling AgentMail inbox");

    // Use AgentMail instead of IMAP
    const emails = await pollInboxViaAgentMail();

    for (const email of emails) {
      await processEmail(email);
    }

    logger.debug("Poll complete", { emailsProcessed: emails.length });
  } catch (error) {
    logger.error("Poll failed", { error: String(error) });
  }
}
```

### Option B: Create New AgentMail Email Listener Skill

Create `skills/agentmail-listener/` with AgentMail-specific implementation.

---

## Step 2: Configure Environment

Set these environment variables:

```bash
export AGENTMAIL_API_KEY="your-agentmail-key"
export AGENTMAIL_INBOX_ADDRESS="timsmail@agentmail.to"
export FRANKOS_EMAIL_INTENT_PARSER_ENABLED="true"
export FRANKOS_EMAIL_INTENT_PARSER_MODEL="claude-haiku-4-5-20251001"
export FRANKOS_EMAIL_INTENT_CONFIDENCE_THRESHOLD="0.7"
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Step 3: Start Tim's Email Listener

```bash
cd /c/devProjects/openclaw/skills/email-listener
npm run build
node --import tsx ./src/index.ts
```

Expected output:
```
Email listener skill initialized
Email listener started
Polling for emails (interval: 300000ms)
```

---

## Step 4: Send Test Email to Tim's AgentMail Inbox

From your email account, send an email **to Tim's AgentMail address**:

**To**: `timsmail@agentmail.to`
**From**: any email address (will be recorded as sender)
**Subject**: `Create a task to review the email listener implementation`
**Body**:
```
Hi Tim,

Can you create a task for me to review the email listener implementation?
This will test if the intent parser is working correctly with AgentMail.

Please set it as high priority.

Thanks!
```

---

## Step 5: Verify Complete Flow

### Check Listener Logs

You should see:
```
2026-03-07T10:15:30.000Z [email-listener] [INFO] Processing email {
  "from": "your-email@example.com",
  "subject": "Create a task to review the email listener implementation"
}

2026-03-07T10:15:30.500Z [email-listener] [DEBUG] Attempting to parse intent from email

2026-03-07T10:15:31.200Z [email-listener] [INFO] Intent parsed with sufficient confidence {
  "action": "CREATE_TASK",
  "confidence": 0.93
}

2026-03-07T10:15:31.300Z [email-listener] [INFO] Executing command {
  "command": "CREATE_TASK",
  "args": ["Review email listener implementation", "high"]
}

2026-03-07T10:15:31.500Z [email-listener] [INFO] Created task from email {
  "taskId": "email-task-1234567890-abc123",
  "title": "Review email listener implementation",
  "priority": "high"
}

2026-03-07T10:15:32.000Z [email-listener] [INFO] Sending response email {
  "to": "your-email@example.com",
  "subject": "Re: Create a task to review the email listener implementation"
}
```

### Check Task File

```bash
cat ~/myVault/00_FrankOS/tasks/email-tasks.json
```

Should contain:
```json
{
  "id": "email-task-1234567890-abc123",
  "title": "Review email listener implementation",
  "description": "Review the email listener implementation as requested",
  "priority": "high",
  "status": "pending",
  "sourceEmail": {
    "from": "your-email@example.com",
    "subject": "Create a task to review the email listener implementation",
    "date": "2026-03-07T10:15:30Z",
    "messageId": "<agentmail-message-id>"
  },
  "tags": ["email", "natural-language"],
  "metadata": {
    "createdBy": "intent-parser"
  },
  "createdAt": "2026-03-07T10:15:31Z"
}
```

### Check Response Email

Response should arrive at your email account from Tim's AgentMail address:

**From**: `timsmail@agentmail.to`
**Subject**: `Re: Create a task to review the email listener implementation`
**Body**:
```
Task created: "Review email listener implementation"

Task Details:
- ID: email-task-1234567890-abc123
- Title: Review email listener implementation
- Priority: high
- Status: pending
- Created: 2026-03-07T10:15:31Z

Task source tracking:
- From: your-email@example.com
- Subject: Create a task to review the email listener implementation
- Message ID: <agentmail-message-id>

Tags: email, natural-language
```

### Check AgentMail Activity Log

```bash
cat logs/email_activity.log | tail -20
```

Should show:
```json
{"timestamp":"2026-03-07T10:15:32.000Z","action":"send_email_success","to":"your-email@example.com","subject":"Re: Create a task...","body_hash":"sha256_hash","message_id":"agentmail_msg_id"}
```

---

## Test Scenarios

Once basic flow works, test these scenarios:

### Test 1: STATUS Query
**Email to Tim**:
```
Subject: What's the system status?
Body: Is everything healthy? Give me a status update.
```

**Expected**:
- Intent: STATUS
- Task created: No
- Response: System health check results

### Test 2: PING Test
**Email to Tim**:
```
Subject: Tim, are you there?
Body: Just pinging to see if you're alive. Respond if you get this.
```

**Expected**:
- Intent: PING
- Task created: No
- Response: Pong + timestamp

### Test 3: Low Confidence Fallback
**Email to Tim**:
```
Subject: Hey Tim
Body: How are you doing today? Nice weather we're having.
```

**Expected**:
- Intent: UNKNOWN
- Confidence: < 0.7
- Task created: No
- Response: None (falls back to subprocess)

### Test 4: High Priority Urgent Task
**Email to Tim**:
```
Subject: URGENT: Fix critical bug in login system
Body: Critical issue - users cannot login. This is ASAP priority.
We need this fixed immediately!
```

**Expected**:
- Intent: CREATE_TASK
- Priority: urgent
- Title: "Fix critical bug in login system"
- Response: Task created confirmation

### Test 5: Multiple Concurrent Emails
Send 5 emails to Tim's inbox in quick succession.

**Expected**:
- All emails processed
- All tasks created
- 5 response emails sent
- No conflicts or data loss

---

## Success Criteria

✅ **Complete E2E Test Successful When**:

1. **Email Received**
   - Log shows: "Processing email"
   - Sender and subject captured correctly

2. **Intent Parsed**
   - Log shows: "Intent parsed with sufficient confidence"
   - Correct action identified (CREATE_TASK, STATUS, PING, etc.)
   - Confidence >= 0.7

3. **Command Executed**
   - Log shows: "Executing command"
   - For CREATE_TASK: task created with correct details

4. **Task Persisted**
   - Task file updated: ~/myVault/00_FrankOS/tasks/email-tasks.json
   - Email source tracking preserved (from, subject, messageId, timestamp)
   - Tags show: ["email", "natural-language"]
   - Metadata shows: { "createdBy": "intent-parser" }

5. **Response Sent**
   - Log shows: "Sending response email"
   - Email arrives at original sender
   - Subject has "Re:" prefix
   - Body contains task details and confirmation

6. **Activity Logged**
   - logs/email_activity.log updated
   - Send action recorded with message hash

---

## Troubleshooting

### Issue: "AGENTMAIL_API_KEY not set"
**Solution**: Set environment variable before starting listener
```bash
export AGENTMAIL_API_KEY="your-key"
```

### Issue: "Failed to poll AgentMail inbox" / 401 Unauthorized
**Solution**:
- Verify API key is correct
- Check key hasn't expired
- Ensure AgentMail endpoint is correct

### Issue: Email received but intent parser fails
**Solution**:
- Verify ANTHROPIC_API_KEY is set
- Check Claude API has available credits
- Review logs for specific error message

### Issue: Task created but no response email
**Solution**:
- Verify sender email is in ALLOWED_SENDERS
- Check rate limits not hit (5/hour, 20/day)
- Verify AgentMail API responding correctly

### Issue: Response email never arrives
**Solution**:
- Check spam/junk folder
- Verify recipient email is correct
- Check AgentMail activity log for send attempts

---

## Next Steps

After successful E2E test:

1. **Performance Metrics**
   - Measure email-to-task latency (target: < 5 seconds)
   - Verify Claude Haiku response time (typically 1-3 seconds)
   - Monitor token usage and costs

2. **Fallback Verification**
   - Test with INTENT_PARSER_ENABLED=false
   - Verify subprocess path still works
   - Confirm graceful degradation

3. **Production Deployment**
   - Set up monitoring/alerts for failure scenarios
   - Configure persistent logging
   - Set up rate limiting for API calls
   - Document operational procedures

4. **Production Readiness**
   - Verify all 72 unit+integration tests still passing
   - Test with real Claude API (not mocked)
   - Monitor costs and performance metrics
   - Set up user documentation

---

## Complete Test Checklist

- [ ] AGENTMAIL_API_KEY set and valid
- [ ] ANTHROPIC_API_KEY set
- [ ] Email listener running
- [ ] Test email sent to Tim's AgentMail inbox
- [ ] Email received by listener (check logs)
- [ ] Intent parsed correctly
- [ ] Task created in JSON file
- [ ] Response email received
- [ ] All task details verified
- [ ] Email source tracking confirmed
- [ ] Fallback test (UNKNOWN action)
- [ ] Multiple concurrent emails tested

---

## Questions?

1. Review logs for specific errors
2. Verify all environment variables set
3. Check API keys are valid and have credits/quota
4. Test AgentMail API connectivity separately if needed
