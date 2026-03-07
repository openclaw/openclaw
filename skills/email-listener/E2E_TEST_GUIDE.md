# End-to-End Test: Real Email to Intent Parser

**Objective**: Send a real email to Tim and verify the complete flow:
Email → Intent Parser → Task Creation → Response Email

---

## Prerequisites

### 1. Email Account Setup
You need an email account that Tim's email listener can monitor. Options:
- **Gmail with App Password** (recommended)
- **Outlook**
- **Any IMAP-enabled email service**

### 2. Required Credentials
```
FRANKOS_EMAIL_IMAP_HOST          = imap.gmail.com (or your provider)
FRANKOS_EMAIL_IMAP_PORT          = 993
FRANKOS_EMAIL_IMAP_USER          = your-email@gmail.com
FRANKOS_EMAIL_IMAP_PASSWORD      = app-password-or-regular-password
FRANKOS_EMAIL_ALLOWED_SENDERS    = sender@example.com
FRANKOS_EMAIL_INTENT_PARSER_ENABLED = true
ANTHROPIC_API_KEY                = your-claude-api-key
```

### 3. Sending Email Account
You'll need a separate email address to send test emails FROM.
This should be in the ALLOWED_SENDERS list.

---

## Step 1: Set Up Tim's Email Listener

### Option A: Gmail (Recommended)

1. **Create App Password**:
   - Go to myaccount.google.com/security
   - Enable 2-factor authentication
   - Create "App password" for "Mail" on "Windows Computer"
   - Copy the 16-character password

2. **Set Environment Variables**:
```bash
export FRANKOS_EMAIL_IMAP_HOST="imap.gmail.com"
export FRANKOS_EMAIL_IMAP_PORT="993"
export FRANKOS_EMAIL_IMAP_SECURE="true"
export FRANKOS_EMAIL_IMAP_USER="your-email@gmail.com"
export FRANKOS_EMAIL_IMAP_PASSWORD="xxxx xxxx xxxx xxxx"  # 16-char app password
```

### Option B: Outlook

```bash
export FRANKOS_EMAIL_IMAP_HOST="imap-mail.outlook.com"
export FRANKOS_EMAIL_IMAP_PORT="993"
export FRANKOS_EMAIL_IMAP_SECURE="true"
export FRANKOS_EMAIL_IMAP_USER="your-email@outlook.com"
export FRANKOS_EMAIL_IMAP_PASSWORD="your-password"
```

### Step 2: Configure Allowed Senders

```bash
export FRANKOS_EMAIL_ALLOWED_SENDERS="frank@example.com,test@example.com"
```

This should include the email address FROM which you'll send test emails.

### Step 3: Enable Intent Parser

```bash
export FRANKOS_EMAIL_INTENT_PARSER_ENABLED="true"
export FRANKOS_EMAIL_INTENT_PARSER_MODEL="claude-haiku-4-5-20251001"
export FRANKOS_EMAIL_INTENT_CONFIDENCE_THRESHOLD="0.7"
export FRANKOS_EMAIL_ENABLE_FREEFORM="true"
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Step 2: Start Tim's Email Listener

### Start the Listener

```bash
cd /c/devProjects/openclaw/skills/email-listener
npm run build  # Build the skill
node --import tsx ./src/index.ts
```

You should see:
```
Email listener skill initialized
Email listener started
```

The listener will poll every 5 minutes (configurable with FRANKOS_EMAIL_POLLING_INTERVAL).

### Check Logs

Monitor the output for:
- ✅ "Processing email" - email received
- ✅ "Attempting to parse intent from email" - intent parser called
- ✅ "Intent parsed with sufficient confidence" - intent recognized
- ✅ "Created task from email" - task created successfully
- ✅ "Sending command result" - response email sent

---

## Step 3: Send Test Email

From your test email account (must be in ALLOWED_SENDERS), send an email to Tim's address with:

### Test 1: Simple Task Creation

**To**: your-email@gmail.com (or whatever Tim is listening to)
**Subject**: Create a task to review the email listener implementation
**Body**:
```
Hi Tim,

Can you create a task for me to review the email listener implementation?
This is to ensure the intent parser is working correctly.

Please set it as high priority.

Thanks!
```

### Expected Results

✅ Email received by listener
✅ Intent parser extracts:
  - Action: CREATE_TASK
  - Confidence: 0.85+
  - Title: "Review email listener implementation"
  - Priority: "high"

✅ Task created in ~/myVault/00_FrankOS/tasks/email-tasks.json
✅ Response email sent back

---

## Step 4: Verify Results

### Check Task File

```bash
cat ~/myVault/00_FrankOS/tasks/email-tasks.json
```

Look for:
```json
{
  "action": "CREATE_TASK",
  "id": "email-task-...",
  "title": "Review email listener implementation",
  "priority": "high",
  "status": "pending",
  "sourceEmail": {
    "from": "sender@example.com",
    "subject": "Create a task to review the email listener implementation",
    "date": "2026-03-07T..."
  },
  "tags": ["email", "natural-language"],
  "metadata": {
    "createdBy": "intent-parser"
  }
}
```

### Check Response Email

The response should arrive in your inbox with:
- **Subject**: Re: Create a task to review the email listener implementation
- **Body**:
```
Task created: "Review email listener implementation"

Task Details:
- Title: Review email listener implementation
- Priority: high
- Status: pending
- Created: 2026-03-07T...
```

---

## Test Scenarios

### Test 1: CREATE_TASK with Priority ✅
**Email**:
```
Create a task to fix the login bug. Make it urgent priority please.
```

**Expected**:
- Intent: CREATE_TASK
- Priority: urgent
- Title: "Fix the login bug"

### Test 2: STATUS Query ✅
**Email**:
```
What's the system status? Is everything healthy?
```

**Expected**:
- Intent: STATUS
- Response: System health check results

### Test 3: PING Test ✅
**Email**:
```
Tim, are you there? Just pinging to see if you're alive.
```

**Expected**:
- Intent: PING
- Response: Pong + timestamp

### Test 4: Low Confidence / Fallback ✅
**Email**:
```
Hey Tim, how are you doing today? Nice weather we're having.
```

**Expected**:
- Intent: UNKNOWN (confidence < 0.7)
- Falls back to subprocess (no direct response)
- Logged as fallback in output

### Test 5: Multiple Tasks 🔄
Send 3-5 emails in sequence to test concurrent handling.

**Expected**:
- All tasks created successfully
- Each has unique ID
- Email source tracked correctly for each

---

## Troubleshooting

### Issue: "IMAP authentication failed"
**Solution**:
- Verify credentials are correct
- For Gmail: Use app password, not regular password
- Check email address is exactly right (case-sensitive for some providers)

### Issue: "No emails received"
**Solution**:
- Check sender email is in ALLOWED_SENDERS
- Wait for next polling cycle (default 5 min)
- Check listener is running and no errors in logs
- Try sending email again

### Issue: "Intent parser error" or "API key not found"
**Solution**:
- Verify ANTHROPIC_API_KEY is set
- Check Claude API has credits available
- Verify model name is correct: claude-haiku-4-5-20251001

### Issue: "Task created but no response email"
**Solution**:
- Check SMTP configuration for sending replies
- Verify recipient email address is valid
- Check rate limits aren't hit (5 emails/hour from Tim)

### Issue: "Task file not found"
**Solution**:
- Create directory: `mkdir -p ~/myVault/00_FrankOS/tasks`
- Verify permissions: `chmod 755 ~/myVault/00_FrankOS`
- Restart listener to create file

---

## Logging and Monitoring

### View Real-Time Logs

The listener outputs detailed logs:
- Email reception
- Intent parsing details
- Task creation results
- Response sending status

### Log Levels

- **INFO**: Normal operation (recommended for testing)
- **DEBUG**: Detailed parsing steps
- **WARN**: Non-critical issues
- **ERROR**: Failures requiring attention

---

## Success Criteria

✅ **All tests pass when**:
1. Email received and logged
2. Intent correctly identified (CREATE_TASK, STATUS, PING, etc.)
3. Task created with correct details (title, priority, email source)
4. Task file updated with new task
5. Response email sent back to sender
6. Email source tracking shows sender details

---

## Next Steps After E2E Test

1. **Performance Metrics**
   - Measure email-to-task latency
   - Verify Claude Haiku latency (should be < 3 seconds)
   - Monitor token usage and costs

2. **Fallback Verification**
   - Test with INTENT_PARSER_ENABLED=false
   - Verify subprocess path still works
   - Confirm graceful degradation

3. **Production Deployment**
   - Set up monitoring/alerts
   - Configure logging to persistent storage
   - Set up rate limiting for API calls
   - Document operational procedures

4. **User Documentation**
   - Create user guide for sending task emails
   - Document supported intent patterns
   - Provide examples of natural language requests

---

## Reference: Email Examples by Intent

### CREATE_TASK Examples
```
"Create a task to review the email listener implementation"
"Please make a task for updating documentation"
"I need a task: fix the login bug"
"Can you create a reminder to test the new feature?"
```

### STATUS Examples
```
"What's the system status?"
"Is everything healthy?"
"Check the system health for me"
"Give me a status update"
```

### PING Examples
```
"Are you there?"
"Tim, ping!"
"Just checking if you're alive"
"Hello, anyone home?"
```

### AGENT_STATUS Examples
```
"Tell me about the agents"
"What agents are running?"
"Show me agent status"
```

### MOVE_EMAIL Examples
```
"Move this to the archive folder"
"Please move to spam"
"Can you organize this email?"
```

---

## Complete Test Checklist

- [ ] Email listener running
- [ ] IMAP credentials working
- [ ] ANTHROPIC_API_KEY set
- [ ] Test email sent
- [ ] Email received by listener
- [ ] Intent parsed correctly
- [ ] Task created in JSON file
- [ ] Response email received
- [ ] All details verified (title, priority, email source)
- [ ] Fallback tested (UNKNOWN action)
- [ ] Multiple concurrent emails tested

---

## Questions?

1. Check logs for specific errors
2. Verify all environment variables set: `env | grep FRANKOS`
3. Test IMAP connection separately
4. Verify Anthropic API key has credits
5. Check firewall/proxy not blocking IMAP or API calls
