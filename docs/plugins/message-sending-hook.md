# Message Sending Hook - Error Suppression

The `message_sending` hook allows plugins to intercept, modify, or suppress outgoing messages, including error messages from providers.

## Hook Event

```typescript
export type PluginHookMessageSendingEvent = {
  to: string;                    // Message recipient
  content: string;                // Message text
  metadata?: Record<string, unknown>;
  isError?: boolean;              // true if this is an error message
  errorType?: string;             // Error classification
  originalError?: string;         // Original error before formatting
};
```

### Error Types

- `rate_limit` - API rate limiting (429 errors)
- `overload` - Provider overload/capacity issues (503 errors)
- `auth` - Authentication failures (401/403)
- `network` - Network timeouts and connection errors
- `provider` - Model or provider errors
- `unknown` - Unclassified errors

## Hook Result

```typescript
export type PluginHookMessageSendingResult = {
  content?: string;  // Modify the message text
  cancel?: boolean;  // Cancel sending (suppress the message)
};
```

## Example: Suppress Rate Limit Errors

```typescript
import type { PluginExtension } from 'openclaw';

export const extension: PluginExtension = {
  id: 'error-suppressor',
  version: '1.0.0',

  async load({ registry }) {
    // Suppress rate limit errors, show friendly message instead
    registry.registerHook({
      pluginId: 'error-suppressor',
      hookName: 'message_sending',
      priority: 100,
      handler: async (event, ctx) => {
        if (event.isError && event.errorType === 'rate_limit') {
          return {
            content: '⏸️ Taking a quick break to avoid rate limits. Try again in a moment!',
          };
        }
        return {};
      },
    });
  },
};
```

## Example: Completely Suppress Errors

```typescript
registry.registerHook({
  pluginId: 'silent-errors',
  hookName: 'message_sending',
  handler: async (event, ctx) => {
    // Suppress all error messages for specific users
    if (event.isError && event.to === 'user:silent-mode') {
      return { cancel: true };
    }
    return {};
  },
});
```

## Example: Customize Error Messages

```typescript
registry.registerHook({
  pluginId: 'friendly-errors',
  hookName: 'message_sending',
  handler: async (event, ctx) => {
    if (!event.isError) return {};

    const friendlyMessages = {
      rate_limit: '🚦 Slow down there! Give me a moment to catch my breath.',
      overload: '😅 I'm a bit overwhelmed right now. Can you try again in a minute?',
      auth: '🔐 Hmm, authentication hiccup. Let me check my credentials.',
      network: '📡 Connection issues. The internet gremlins are at it again!',
    };

    const friendly = friendlyMessages[event.errorType];
    if (friendly) {
      return { content: friendly };
    }

    return {};
  },
});
```

## Integration Status

**Infrastructure:** ✅ Complete
**Hook Definition:** ✅ Ready to use
**Error Classification:** ✅ Available via `classifyErrorMessage()`
**Delivery Integration:** ⏳ Pending

The hook infrastructure is ready. Integration into the message delivery pipeline can be added as needed.
