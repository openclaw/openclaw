# Quick Start: End-to-End Test with Real Email

**Goal**: Send a real email to Tim's AgentMail inbox and verify the complete intent parser flow works.

---

## 5-Minute Setup

### 1. Set Environment Variables

```bash
# Your AgentMail API key (you already have this)
export AGENTMAIL_API_KEY="your-key-from-yesterday"

# Claude API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Optional - defaults to these values:
export FRANKOS_EMAIL_AGENTMAIL_INBOX="timsmail@agentmail.to"
export AGENTMAIL_API_URL="https://api.agentmail.to"
```

### 2. Build and Start Tim's Email Listener

```bash
cd /c/devProjects/openclaw/skills/email-listener

npm run build

node --import tsx ./src/index.ts
```

**Expected Output**:
```
AgentMail configured, performing health check
AgentMail health check { healthy: true, message: 'Connected to AgentMail (timsmail@agentmail.to)' }
Email listener skill initialized
Email listener started
Polling for emails
```

The listener will poll for emails every 5 minutes (or immediately when you send one).

---

## Send Test Email

From your email account, send an email **to Tim's AgentMail inbox**:

### Test Email 1: CREATE_TASK

```
To: timsmail@agentmail.to
Subject: Create a task to review the email listener
Body:

Hi Tim,

Can you create a task for me? I'd like you to review the email listener
implementation to make sure the intent parser is working correctly.

Please mark it as high priority.

Thanks!
```

---

## Watch the Magic Happen

### In Terminal (where listener is running):

You should see logs like:
```
Polling for emails
[INFO] Processing email {
  "from": "your-email@example.com",
  "subject": "Create a task to review the email listener"
}

[DEBUG] Attempting to parse intent from email

[INFO] Intent parsed with sufficient confidence {
  "action": "CREATE_TASK",
  "confidence": 0.93,
  "reasoning": "User explicitly requests to create a task"
}

[INFO] Executing command {
  "command": "CREATE_TASK",
  "args": ["Review email listener", "high", "Review the implementation"]
}

[INFO] Created task from email {
  "taskId": "email-task-1234567890-abc",
  "title": "Review email listener",
  "priority": "high"
}

[INFO] Sending response email via AgentMail {
  "to": "your-email@example.com",
  "subject": "Re: Create a task to review the email listener"
}
```

### In Your Email Inbox:

Response email arrives from Tim:
```
From: timsmail@agentmail.to
To: your-email@example.com
Subject: Re: Create a task to review the email listener

Task created: "Review email listener"

Task Details:
- Title: Review email listener
- Priority: high
- Status: pending
- Created: 2026-03-07T...

Task source tracking:
- From: your-email@example.com
- Subject: Create a task to review the email listener
- Message ID: <...>

Tags: email, natural-language
```

### In Task File:

```bash
cat ~/myVault/00_FrankOS/tasks/email-tasks.json
```

Shows the new task with email source tracking:
```json
{
  "id": "email-task-...",
  "title": "Review email listener",
  "priority": "high",
  "status": "pending",
  "sourceEmail": {
    "from": "your-email@example.com",
    "subject": "Create a task to review the email listener"
  },
  "tags": ["email", "natural-language"],
  "metadata": {
    "createdBy": "intent-parser"
  }
}
```

---

## Success! 🎉

You've successfully tested:
- ✅ Email received via AgentMail API
- ✅ Intent parsed by Claude Haiku ("CREATE_TASK")
- ✅ Task created with correct details
- ✅ Email source tracked (sender, subject, timestamp)
- ✅ Response email sent via AgentMail

---

## More Tests to Try

Once basic test works, try these:

### Test 2: STATUS Query
```
Subject: What's the system status?
Body: Is everything healthy?
```
→ Tim responds with system health info

### Test 3: PING
```
Subject: Ping
Body: Are you alive?
```
→ Tim responds with "Pong + timestamp"

### Test 4: Multiple Tasks
Send 3-5 emails in sequence
→ All tasks created, no conflicts

### Test 5: Low Confidence (Fallback)
```
Subject: Hey Tim
Body: How's the weather today?
```
→ No response (UNKNOWN intent, falls back to subprocess)

---

## Troubleshooting

### "AGENTMAIL_API_KEY not set"
```bash
export AGENTMAIL_API_KEY="your-actual-key"
```

### "ANTHROPIC_API_KEY not set"
```bash
export ANTHROPIC_API_KEY="sk-ant-your-key"
```

### "Failed to poll AgentMail inbox" (401 Unauthorized)
- Verify API key is correct
- Check key hasn't expired
- Check AgentMail API status

### Email received but no intent parsing
- Check ANTHROPIC_API_KEY is set
- Check Claude API account has credits
- Look for error in listener logs

### Task created but no response email
- Check your email address is valid
- Verify you can receive emails from agentmail.to
- Check spam folder

---

## Complete Flow Verification

- [ ] AGENTMAIL_API_KEY set
- [ ] ANTHROPIC_API_KEY set
- [ ] Email listener running
- [ ] Email sent to timsmail@agentmail.to
- [ ] Logs show "Processing email"
- [ ] Logs show "Intent parsed with sufficient confidence"
- [ ] Task file created/updated
- [ ] Response email received
- [ ] Task details correct in JSON file
- [ ] Email source (from, subject) recorded

---

## Next Steps

After successful E2E test:

1. **Try more intent types** (STATUS, PING, etc.)
2. **Test fallback** (low confidence → no response)
3. **Verify performance** (measure latency)
4. **Production deployment** (set up monitoring/logging)

---

## Need Help?

Check `/c/devProjects/openclaw/skills/email-listener/E2E_TEST_AGENTMAIL.md` for detailed setup instructions.
