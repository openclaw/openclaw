# Private UPC (User Protocol Credential) Feature - Integration Guide

## Overview

The Private UPC feature adds an optional security layer requiring a user-provided code word before executing high-risk operations in OpenClaw. This guide explains how the feature is implemented and how to integrate it into the control UI.

## Architecture

### Components

1. **UPC Manager** (`src/security/upc-manager.ts`)
   - Core credential management with SHA-256 hashing
   - Session-based verification tracking with 1-hour expiration
   - Rate limiting: max 5 failed attempts per 5-minute window
   - Audit logging of all verification attempts
   - Global singleton instance for application-wide access

2. **Protocol Schemas** (`src/gateway/protocol/schema/upc.ts`)
   - `UPCVerificationRequest`: Request to verify credential for a task
   - `UPCVerificationResponse`: Result of verification attempt
   - `UPCSetRequest/Response`: Setting or updating UPC credentials
   - `UPCStatusRequest/Response`: Querying UPC status
   - `UPCApprovalRequest`: For integration with approval workflows

3. **UPC Verification Handler** (`src/agents/upc-verification.ts`)
   - Task classification logic (identifies high-risk tools)
   - UPC requirement checking
   - Challenge payload generation
   - Session verification status tracking

4. **Tool Execution Integration** (`src/agents/pi-tools.before-tool-call.ts`)
   - Modified `runBeforeToolCallHook` to check UPC requirements
   - Blocks high-risk tasks if UPC verification is required but not yet verified
   - Returns JSON-formatted challenge payload for UI handling

5. **Gateway Server Methods** (`src/gateway/server-methods/upc.ts`)
   - `upc.status`: Get current UPC status (public endpoint)
   - `upc.set`: Set/update UPC credential (admin only)
   - `upc.disable`: Disable UPC protection (admin only)
   - `upc.verify`: Verify UPC credential attempt
   - `upc.approval.create`: Create approval request for high-risk task
   - `upc.audit-log`: Get audit log (admin only)

6. **UI Components** 
   - `src/ui/upc-verification-dialog.ts`: Modal for UPC verification during task execution
   - `src/ui/upc-settings-panel.ts`: Settings panel for UPC configuration

### Gateway Configuration Extension

The `GatewayRuntimeConfig` type in `src/gateway/server-runtime-config.ts` now includes:

```typescript
upcConfig?: {
  enabled: boolean;
  hasUPC: boolean;  // Marker flag (credential hash is never exposed)
};
```

## High-Risk Tasks Requiring UPC

When UPC is enabled, the following tasks require verification:

- `exec` - Execute system command
- `spawn` - Spawn new process
- `shell` - Execute shell command
- `fs_write` - Write to file system
- `fs_delete` - Delete file(s)
- `fs_move` - Move/rename file(s)
- `sessions_spawn` - Spawn new session
- `sessions_send` - Send command to session
- `gateway` - Reconfigure gateway
- `apply_patch` - Apply code patch

## Integration Points

### 1. Control UI - Settings Panel

Add UPC settings to the control UI settings/config view:

```typescript
// In your control UI settings component
import { renderUPCSettingsPanel, getUPCSettingsPanelStyles, createUPCSettingsState } from './src/ui/upc-settings-panel';

// Add styles
const styles = getUPCSettingsPanelStyles();

// Render settings panel
const settingsPanel = renderUPCSettingsPanel(state);

// Handle UPC.set method
async function handleSetUPC(credential: string) {
  const response = await gateway.call('upc.set', { credential });
  // Update UI based on response
}
```

### 2. Control UI - Task Execution

Handle UPC verification challenges during task execution:

```typescript
// In your tool/task execution handler
import { renderUPCVerificationModal, getUPCModalStyles, createUPCVerificationDialogState } from './src/ui/upc-verification-dialog';

function handleToolBlockedByUPC(errorMessage: string) {
  try {
    // Error message contains JSON-formatted UPCChallengePayload
    const challenge = JSON.parse(errorMessage);
    
    if (challenge.type === 'upc_verification_required') {
      // Show verification modal
      const state = createUPCVerificationDialogState(
        challenge.taskName,
        challenge.taskDescription,
        challenge.approvalId
      );
      
      const html = renderUPCVerificationModal(state);
      showModal(html);
      
      // Handle verification attempt
      const input = getInputValue(); // From modal
      const result = await gateway.call('upc.verify', {
        upcInput: input,
        taskName: challenge.taskName
      });
      
      if (result.verified) {
        // Retry the original tool call
        retryToolCall();
      } else {
        // Show error and update remaining attempts
        updateModalError(result.error, result.remainingAttempts);
      }
    }
  } catch (e) {
    // Not a UPC challenge, handle as regular error
  }
}
```

### 3. Approval Workflow Integration

If using the approval workflow system:

```typescript
// Create approval request for high-risk task
const approval = await gateway.call('upc.approval.create', {
  taskName: 'exec',
  taskDescription: 'Execute system command'
});

// Combine with approval workflow
const approvalRequest = {
  ...approval,
  // Add approval workflow fields as needed
};
```

## API Reference

### Gateway Methods

All methods require the client to be connected and authenticated.

#### upc.status
Get current UPC status without exposing credentials.

**Request:**
```json
{}
```

**Response:**
```json
{
  "enabled": true,
  "hasUPC": true,
  "isLocked": false
}
```

#### upc.set
Set or update the UPC credential. Requires admin scope.

**Request:**
```json
{
  "credential": "my-secret-code-word"
}
```

**Response:**
```json
{
  "success": true,
  "error": null
}
```

#### upc.disable
Disable UPC protection. Requires admin scope.

**Request:**
```json
{}
```

**Response:**
```json
{
  "success": true
}
```

#### upc.verify
Verify a UPC credential attempt.

**Request:**
```json
{
  "upcInput": "user-entered-code-word",
  "taskName": "exec",
  "taskDescription": "Execute system command"
}
```

**Response:**
```json
{
  "verified": true,
  "remainingAttempts": 5,
  "error": null
}
```

On failure:
```json
{
  "verified": false,
  "remainingAttempts": 3,
  "error": "Incorrect UPC. Please try again."
}
```

#### upc.approval.create
Create approval request for high-risk task.

**Request:**
```json
{
  "taskName": "exec",
  "taskDescription": "Execute system command"
}
```

**Response:**
```json
{
  "id": "upc-1234567890-abc123",
  "taskName": "exec",
  "taskDescription": "Execute system command",
  "createdAtMs": 1234567890
}
```

#### upc.audit-log
Get audit log entries. Requires admin scope.

**Request:**
```json
{
  "limit": 50
}
```

**Response:**
```json
{
  "entries": [
    {
      "timestamp": 1234567890,
      "action": "verify_success",
      "sessionId": "session-123",
      "success": true
    },
    // ... more entries
  ]
}
```

## Security Considerations

### Credential Storage
- Credentials are hashed using SHA-256 before storage
- Hash is stored in memory in the UPC Manager
- Never expose the plaintext credential or hash in API responses
- Only expose `hasUPC` boolean flag indicating whether a credential is set

### Rate Limiting
- Maximum 5 failed verification attempts per 5-minute window per session
- After 5 failures, session is locked for 15 minutes
- Attempt counter resets on successful verification
- Exponential backoff can be implemented in the UI for better UX

### Session Management
- Verification is tied to specific session ID
- Each verification expires after 1 hour
- Verification is automatically cleared when session ends
- Sessions can be manually cleared via `clearSessionVerification()`

### Audit Logging
- All verification attempts (success and failure) are logged
- Audit log includes timestamp, action, session ID, and attempt count
- Admin can access audit log via `upc.audit-log` method
- Log is kept in memory (last 1000 entries) for performance

### Data Isolation
- Each account has its own UPC setting (not shared across users)
- Session-based verification prevents cross-session attacks
- Admin scope required for sensitive operations (set/disable/audit-log)

## Implementation Checklist

For control UI integration:

- [ ] Add UPC settings panel to settings view
- [ ] Add styles from `getUPCSettingsPanelStyles()`
- [ ] Implement UPC.set method handler
- [ ] Implement UPC.disable method handler
- [ ] Add tool execution error handler for UPC challenges
- [ ] Add UPC verification modal with styles
- [ ] Implement UPC.verify method handler
- [ ] Add "Verify" button retry logic for blocked tasks
- [ ] Test all UPC flows: enable, verify, rate limiting, session expiry
- [ ] Add UPC settings to user documentation

## Testing

### Manual Testing Flow

1. **Enable UPC:**
   - Go to settings
   - Click "Enable UPC Protection"
   - Enter code word: `test-secret-code`
   - Confirm code word
   - Click "Enable"
   - Verify status shows "UPC Protection Active"

2. **Execute High-Risk Task (Blocked):**
   - Try to execute `exec` command
   - Modal appears asking for UPC
   - Leave empty and click "Verify"
   - Error message appears: "Incorrect UPC"
   - Remaining attempts shown

3. **Verify UPC:**
   - Enter correct code word: `test-secret-code`
   - Click "Verify"
   - Modal closes
   - Tool execution proceeds

4. **Session Persistence:**
   - In same session, execute another high-risk task
   - Should NOT require verification (session is verified)

5. **Rate Limiting:**
   - Enter wrong code word 5 times
   - Account locked message appears
   - Try to verify again
   - Get "Try again in X seconds" message

6. **Disable UPC:**
   - Go to settings
   - Click "Disable UPC Protection"
   - Confirm

## Troubleshooting

### UPC not required for high-risk task
- Verify that `isHighRiskTask()` correctly classifies the tool
- Check that UPC is enabled via `upc.status` endpoint
- Verify session ID is being passed to verification handler

### Verification fails with "credential not found"
- Ensure UPC was set via `upc.set` method first
- Check that UPC Manager instance is the same globally
- Verify `hasUPC` flag is true in status response

### Session stays verified after logout
- Clear verification on session end: `clearSessionVerification(sessionId)`
- Ensure session ID is unique across sessions
- Check verification expiry timeout is working

### Rate limiting not working
- Verify rate limit attempt counter is being incremented
- Check that session ID is consistent across requests
- Ensure 5-minute window is being respected

## Future Enhancements

- Time-based credentials (TOTP)
- Multi-factor verification (PIN + code word)
- Biometric authentication
- Per-task verification instead of session-wide
- Configurable task classification rules
- Integration with external authentication systems
