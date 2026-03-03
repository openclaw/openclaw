# React UPC Integration Guide

This guide shows how to integrate the Private UPC verification components into your React-based control UI.

## Components

### 1. UPCVerificationModal

A modal dialog that appears when a user attempts a high-risk operation.

**Location:** `src/ui/react/upc-verification-modal.tsx`

**Props:**
```typescript
interface UPCVerificationModalProps {
  isOpen: boolean;
  taskDescription: string;
  onVerify: (upc: string) => Promise<void>;
  onCancel: () => void;
}
```

**Example Usage:**
```tsx
import { UPCVerificationModal } from '@/ui/react/upc-verification-modal';

function AgentView() {
  const [challenge, setChallenge] = useState(null);

  return (
    <>
      <UPCVerificationModal
        isOpen={!!challenge}
        taskDescription={challenge?.taskDescription || ''}
        onVerify={async (upc) => {
          // Send verification to gateway
          await gatewayClient.call('security.upc.verify', {
            challengeId: challenge.challengeId,
            credential: upc,
          });
          setChallenge(null);
        }}
        onCancel={() => setChallenge(null)}
      />
    </>
  );
}
```

### 2. UPCSettingsPanel

A settings panel for managing UPC configuration.

**Location:** `src/ui/react/upc-settings-panel.tsx`

**Props:**
```typescript
interface UPCSettingsPanelProps {
  onSave?: (config: UPCConfig) => Promise<void>;
  isLoading?: boolean;
}

interface UPCConfig {
  enabled: boolean;
  upc?: string;
}
```

**Example Usage:**
```tsx
import { UPCSettingsPanel } from '@/ui/react/upc-settings-panel';

function SettingsView() {
  return (
    <div className="settings-container">
      <UPCSettingsPanel
        onSave={async (config) => {
          await gatewayClient.call('security.upc.set', {
            upc: config.upc,
            enabled: config.enabled,
          });
        }}
      />
    </div>
  );
}
```

### 3. useUPCVerification Hook

A custom hook for managing the verification flow.

**Location:** `src/ui/react/use-upc-verification.ts`

**Return Value:**
```typescript
interface UseUPCVerificationReturn {
  challenge: UPCChallenge | null;
  isOpen: boolean;
  isVerifying: boolean;
  showChallenge: (challenge: UPCChallenge) => void;
  closeChallenge: () => void;
  verifyUPC: (upc: string) => Promise<void>;
  handleToolCall: (toolName: string, taskDescription: string) => Promise<string | null>;
}
```

**Example Usage:**
```tsx
import { useUPCVerification } from '@/ui/react/use-upc-verification';

function AgentExecutor() {
  const { challenge, isOpen, verifyUPC, closeChallenge, handleToolCall } =
    useUPCVerification(gatewayClient);

  const executeCommand = async (toolName: string) => {
    // Check if UPC verification is needed
    const challengeId = await handleToolCall(
      toolName,
      'Execute command: ' + toolName
    );

    if (challengeId) {
      // Verification is required, modal will show automatically
      return;
    }

    // Proceed with execution
    await executeToolDirectly(toolName);
  };

  return (
    <>
      {challenge && (
        <UPCVerificationModal
          isOpen={isOpen}
          taskDescription={challenge.taskDescription}
          onVerify={verifyUPC}
          onCancel={closeChallenge}
        />
      )}
    </>
  );
}
```

## Integration Steps

### Step 1: Add to Settings Page

In your settings or security section of the control UI:

```tsx
// pages/settings/security.tsx
import { UPCSettingsPanel } from '@/ui/react/upc-settings-panel';

export default function SecuritySettings() {
  const gatewayClient = useGatewayClient();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Security Settings</h1>
        <p className="text-gray-600">Manage your account security</p>
      </div>

      <UPCSettingsPanel
        onSave={async (config) => {
          await gatewayClient.call('security.upc.set', {
            upc: config.upc,
            enabled: config.enabled,
          });
        }}
      />
    </div>
  );
}
```

### Step 2: Add to Agent/Command Execution View

Intercept tool calls to check for UPC requirements:

```tsx
// components/CommandExecutor.tsx
import { UPCVerificationModal } from '@/ui/react/upc-verification-modal';
import { useUPCVerification } from '@/ui/react/use-upc-verification';

export function CommandExecutor() {
  const gatewayClient = useGatewayClient();
  const { challenge, isOpen, verifyUPC, closeChallenge, handleToolCall } =
    useUPCVerification(gatewayClient);
  const [isExecuting, setIsExecuting] = useState(false);

  const executeCommand = async (cmd: ExecutableCommand) => {
    try {
      setIsExecuting(true);

      // Check UPC requirement
      const pendingChallengeId = await handleToolCall(
        cmd.name,
        getTaskDescription(cmd)
      );

      if (pendingChallengeId) {
        // Modal is shown, wait for user to verify
        return;
      }

      // Execute the command
      const result = await gatewayClient.call('agent.execute', { cmd });
      handleCommandResult(result);
    } catch (err) {
      handleError(err);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <>
      <div className="command-panel">
        {/* Your command UI here */}
      </div>

      <UPCVerificationModal
        isOpen={isOpen}
        taskDescription={challenge?.taskDescription || ''}
        onVerify={verifyUPC}
        onCancel={closeChallenge}
      />
    </>
  );
}
```

### Step 3: Handle UPC Challenges in WebSocket Messages

When the gateway sends a UPC challenge, handle it in your message handler:

```tsx
// hooks/useGatewayMessages.ts
function handleGatewayMessage(msg: GatewayMessage) {
  if (msg.type === 'upc-challenge') {
    // Extract challenge from message
    const challenge = JSON.parse(msg.payload);
    showUPCModal(challenge);
  }
}
```

## API Reference

All UPC operations are gateway server methods:

### security.upc.set

Set or update the UPC credential.

**Request:**
```json
{
  "upc": "your-secret-code",
  "enabled": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "UPC set successfully"
}
```

### security.upc.verify

Verify a UPC for a given challenge.

**Request:**
```json
{
  "challengeId": "challenge-uuid",
  "credential": "user-provided-code"
}
```

**Response:**
```json
{
  "verified": true,
  "message": "Verification successful"
}
```

### security.upc.getStatus

Get the current UPC status (admin only).

**Response:**
```json
{
  "enabled": true,
  "hasUPC": true,
  "attemptsRemaining": 5,
  "lastAttempt": "2024-01-15T10:30:00Z"
}
```

### security.upc.requestChallenge

Request a verification challenge for a tool call.

**Request:**
```json
{
  "toolName": "bash.exec",
  "taskDescription": "Execute shell command"
}
```

**Response:**
```json
{
  "challengeId": "challenge-uuid",
  "requiresVerification": true,
  "expiresAt": "2024-01-15T10:35:00Z"
}
```

## Styling

The components use standard Tailwind CSS classes and can be customized by:

1. **Overriding Tailwind classes** in your theme
2. **Creating wrapper components** with custom styling
3. **Using CSS modules** for additional customization

Example with custom styling:

```tsx
import { UPCVerificationModal } from '@/ui/react/upc-verification-modal';
import styles from './custom-modal.module.css';

export function CustomUPCModal(props) {
  return (
    <div className={styles.customContainer}>
      <UPCVerificationModal {...props} />
    </div>
  );
}
```

## Error Handling

The components include built-in error handling:

- **Failed verification:** Shows error message with remaining attempts
- **Rate limiting:** Displays lockout message
- **Network errors:** Displays error and allows retry
- **Session errors:** Prompts re-authentication

## Accessibility

All components follow WCAG 2.1 AA standards:

- Proper label associations
- Keyboard navigation support
- Screen reader friendly
- Clear error messages
- High contrast mode support

## Security Best Practices

1. **Always verify on the server:** Never trust client-side verification
2. **Use HTTPS:** Ensure all API calls are encrypted
3. **Rate limit:** The server enforces 5 attempts per 15 minutes
4. **Session binding:** Verification is tied to the session
5. **Audit logging:** All verification attempts are logged

## Testing

Example test setup:

```tsx
import { render, screen, userEvent } from '@testing-library/react';
import { UPCVerificationModal } from '@/ui/react/upc-verification-modal';

test('shows verification modal and handles input', async () => {
  const onVerify = jest.fn();
  const onCancel = jest.fn();

  render(
    <UPCVerificationModal
      isOpen={true}
      taskDescription="Execute command"
      onVerify={onVerify}
      onCancel={onCancel}
    />
  );

  const input = screen.getByPlaceholderText('Enter your code word');
  await userEvent.type(input, 'test-code-word');

  const verifyBtn = screen.getByRole('button', { name: /verify/i });
  await userEvent.click(verifyBtn);

  expect(onVerify).toHaveBeenCalledWith('test-code-word');
});
```

## Troubleshooting

### Modal doesn't appear

- Check that UPC is enabled: `gatewayClient.call('security.upc.getStatus')`
- Verify the challenge is being sent properly
- Check browser console for errors

### Verification always fails

- Ensure the server can reach the UPC manager
- Check that the challenge hasn't expired
- Verify the user entered the correct code word

### Rate limiting issues

- Wait 15 minutes for the lockout to expire
- Check the `attemptsRemaining` in the status
- The server resets attempts daily

## Support

For issues or questions, refer to the main `UPC_INTEGRATION_GUIDE.md` for backend integration details.
