# Tim Email Listener Skill - Implementation Plan

## Objective
Extend the Tim (Guardian Agent) to provide email-based remote command interface for FrankOS.

---

## Architecture Overview

```
Email Inbox (IMAP)
       │
       ▼
Tim Email Listener Skill
       │
       ▼
Message Parser / Classifier
       │
 ┌────┴─────────────────────┐
 │                          │
Command Email           Normal Email
 │                          │
 ▼                          ▼
Execute Allowed       Ignore or Notify
Command                    │
 ▼                          │
Send Structured Reply ───────┘
```

---

## Implementation Tasks

### T001: Create Skill Structure
Create new skill directory: `skills/email-listener/`

Files to create:
- `SKILL.md` - Skill documentation
- `src/index.ts` - Main skill entry point
- `src/poll_inbox.ts` - IMAP polling logic
- `src/parse_email.ts` - Email parsing
- `src/classify_message.ts` - Message classification
- `src/execute_command.ts` - Command dispatch
- `src/send_response.ts` - Email response sending
- `src/config.ts` - Configuration management
- `src/types.ts` - TypeScript type definitions
- `src/logger.ts` - Logging utilities

### T002: Implement Email Polling (poll_inbox.ts)
- Connect to mailbox via IMAP using `imap` npm package
- Poll every 5 minutes (configurable)
- Retrieve unread messages
- Mark messages as read after processing
- Handle connection errors gracefully

**Dependencies:**
- `imap` - IMAP client library
- `mailparser` - Email parsing

### T003: Implement Message Parser (parse_email.ts)
Extract from email:
- `sender` - From address
- `subject` - Email subject
- `body` - Email body (plain text)
- `timestamp` - Received time
- `messageId` - Unique message ID

Return structured object.

### T004: Implement Message Classifier (classify_message.ts)

Classification logic:
```
if sender not in allowed_senders:
    return "unauthorized"

if subject starts with "TIM:":
    return "command"
else:
    return "normal"
```

Command subtypes:
- `TIM:STATUS` - Status request
- `TIM:RUN <task>` - Execute task
- `TIM:CONFIRM <action>` - Confirmation response

### T005: Implement Command Executor (execute_command.ts)

Initial command handlers:

| Command | Function | Risk Level |
|---------|----------|-------------|
| STATUS | System health report | Safe |
| SECURITY_AUDIT | Run security scan | Medium |
| CHECK_UPDATES | Check OpenClaw updates | Medium |
| MEMORY_COMPACT | Compact memory files | Medium |
| AGENT_STATUS | Report agent health | Safe |

**Risk classification:**
- Safe: Execute immediately
- Medium: Log and execute
- High: Require confirmation

### T006: Implement Email Response (send_response.ts)
- Use existing himalaya skill for SMTP sending
- Format structured responses
- Reply to original sender
- Include status codes

### T007: Implement Security Controls

**Sender Whitelist:**
- Store allowed emails in config
- Validate before any processing
- Ignore unauthorized senders silently

**Confirmation Protocol:**
- For high-risk commands, reply with confirmation request
- Wait for `TIM:CONFIRM` reply
- Execute only after explicit confirmation
- 5-minute confirmation window

### T008: Implement Logging
- Log all email interactions to `logs/email_commands.log`
- Log format:
  ```
  [YYYY-MM-DD HH:mm:ss]
  Command: <command>
  Sender: <email>
  Result: SUCCESS|FAILED
  Error: <error message if any>
  ```

### T009: Create Skill Documentation (SKILL.md)
- Overview
- Prerequisites (IMAP credentials)
- Configuration
- Supported commands
- Security model
- Examples

### T010: Configure Tim Agent
Update Tim's capability manifest to include:
- Email listener skill
- Available commands
- Polling interval

### T011: Create Test Cases

Test 1: Status Command
```
Send: Subject: TIM:STATUS
Expected: System health report
```

Test 2: Unauthorized Sender
```
Send from: unauthorized@example.com
Expected: Ignored (no response)
```

Test 3: Invalid Command
```
Send: Subject: TIM:DO_SOMETHING
Expected: Error response with valid commands
```

Test 4: Security Audit
```
Send: Subject: TIM:RUN SECURITY AUDIT
Expected: Audit executes and results returned
```

Test 5: Confirmation Flow
```
Send: Subject: TIM:DELETE AGENT
Expected: Confirmation request
Send: Subject: TIM:CONFIRM DELETE AGENT tim
Expected: Command executes
```

---

## Configuration Schema

```typescript
interface EmailListenerConfig {
  // IMAP Settings
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string; // Reference to secret
  };
  
  // Security
  security: {
    allowedSenders: string[];
    requireConfirmation: string[]; // Commands requiring confirmation
    confirmationTimeout: number; // milliseconds
  };
  
  // Polling
  polling: {
    intervalMs: number;
    enabled: boolean;
  };
  
  // Commands
  commands: {
    enabled: string[];
    disabled: string[];
  };
}
```

---

## File Locations

| Component | Location |
|-----------|----------|
| Skill | `skills/email-listener/` |
| Config | `~/.openclaw/config/email-listener.json` |
| Secrets | `~/.openclaw/secrets/` (IMAP password) |
| Logs | `logs/email_commands.log` |

---

## Integration Points

1. **Himalaya Skill** - Reuse for sending responses
2. **FrankOS Runtime** - Read agent status from `20_Runtime/`
3. **Secrets Store** - Store IMAP credentials securely

---

## Acceptance Criteria

- [ ] Tim polls inbox every 5 minutes
- [ ] Only whitelisted senders can execute commands
- [ ] TIM: prefix required for all commands
- [ ] Status command returns system health
- [ ] Security audit command executes
- [ ] High-risk commands require confirmation
- [ ] All interactions logged
- [ ] Error responses include valid commands list

---

## Security Considerations

1. **Never** execute commands from unknown senders
2. **Always** log all command attempts
3. **Confirm** destructive commands before execution
4. **Encrypt** IMAP credentials at rest
5. **Timeout** confirmation requests after 5 minutes
