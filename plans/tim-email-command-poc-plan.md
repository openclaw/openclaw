# Tim Email Command POC - Implementation Complete

## Overview

This document describes the implementation of an email-based command processing system for the Tim Guardian Agent. Users can send commands via email and receive automated responses.

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
│  Email Client   │────▶│  AgentMail Gateway           │────▶│  OpenClaw   │
│  (Sender)       │     │  (services/agentmail-        │     │  Gateway    │
│                 │◀────│   gateway.js)                │◀────│             │
└─────────────────┘     └──────────────────────────────┘     └─────────────┘
```

## Components

### 1. Email Gateway (`services/agentmail-gateway.js`)

- Polls email inbox every 30 seconds
- Parses incoming emails for `TIM:COMMAND` format
- Validates sender against allowlist
- Processes commands and sends replies
- Logs all activity

### 2. Configuration (`config/agent_email.json`)

- Email provider settings
- Security allowlists for senders and recipients
- Rate limiting configuration

### 3. Supported Commands

| Command | Description |
|---------|-------------|
| `TIM:STATUS` | Returns Tim's current status |
| `TIM:AGENT STATUS` | Returns status of all agents |
| `TIM:CHECK UPDATES` | Checks for available system updates |

## Key Implementation Details

### Email Address Parsing

The system handles email addresses in "Name <email@domain.com>" format by extracting the email portion before validation:

```javascript
function extractEmail(sender) {
  if (!sender) return '';
  
  // Try to match email in angle brackets: "Name <email@domain.com>"
  const angleBracketMatch = sender.match(/<([^>]+)>/);
  if (angleBracketMatch) {
    return angleBracketMatch[1].toLowerCase().trim();
  }
  
  // Otherwise use the whole string as email
  return sender.toLowerCase().trim();
}
```

This fix was applied to both `validateSender()` and `validateRecipient()` functions to handle the common email format where addresses appear as `"Sender Name <email@domain.com>"` instead of just the raw email address.

### Security

- Sender allowlist validates who can send commands
- Recipient allowlist validates who can receive replies
- Rate limiting: 5 emails/hour, 20 emails/day
- Message deduplication prevents reprocessing

### Configuration

```json
{
  "email": "timsmail@agentmail.to",
  "provider": "agentmail",
  "security": {
    "sender_allowlist": [
      "fjventura20@gmail.com",
      "fjventura20@outlook.com",
      "timsmail@agentmail.to"
    ],
    "recipient_allowlist": [
      "fjventura20@gmail.com",
      "fjventura20@outlook.com",
      "timsmail@agentmail.to"
    ]
  }
}
```

## Running the Service

### Start the Email Gateway

```powershell
cd c:\devProjects\openclaw
node services/agentmail-gateway.js
```

### Test Commands

Send an email to `timsmail@agentmail.to` with subject:
- `TIM:STATUS` - Get Tim's status
- `TIM:AGENT STATUS` - Get all agent statuses  
- `TIM:CHECK UPDATES` - Check for updates

## Bugs Fixed

1. **Missing polling loop**: The gateway now polls every 30 seconds instead of running once and exiting.

2. **Argument passing**: Fixed `runOnce()` to properly call `processInboxCommands(messages, config)` instead of passing no arguments.

3. **Email format parsing**: Added `extractEmail()` helper to parse "Name <email@domain.com>" format before comparing against allowlists. Both sender and recipient validation now use this helper.

4. **Allowlist configuration**: Added `timsmail@agentmail.to` to both sender and recipient allowlists.

## Files Modified

- `services/agentmail-gateway.js` - Main gateway implementation
- `config/agent_email.json` - Configuration with allowlists

## Future Enhancements

- Add more command handlers
- Implement command execution via OpenClaw CLI
- Add authentication via signed emails
- Support for attachments
