# TUI Recovery Integration - Implementation Notes

## What Was Implemented

### Files Created
- `src/tui/recovery-handler.ts` - Recovery suggestion detection and formatting

### Files Modified  
- `src/tui/tui-event-handlers.ts` - Integrated recovery detection into error handling

## Implementation Details

### Recovery Handler (`recovery-handler.ts`)

**Functions:**
1. `extractRecoverySuggestion(message)` - Extracts `meta.recoverySuggestion` from message object
2. `formatRecoverySuggestion(suggestion)` - Formats suggestion as human-readable text
3. `shouldDisplayRecoverySuggestion(suggestion, maxAttempts)` - Checks if suggestion should be shown

**Message Format:**
```
🔄 Recoverable Error Detected

Reason: <error reason>

Available actions:
  • Retry with the same model
  • Switch to: <suggested-model>
  • Abort (keep error visible)

To retry manually, use:
  /retry          (same model)
  /retry model=<suggested-model>  (switch model)

Recovery attempt: N
```

### Event Handler Integration (`tui-event-handlers.ts`)

**Changes:**
1. Import recovery handler functions
2. Check for recovery suggestion in `evt.state === "error"` handler
3. Check for recovery suggestion in `evt.state === "final"` when `stopReason === "error"`
4. Display formatted recovery message when suggestion found
5. Fall back to standard error message when no suggestion

## Current Limitations

### Manual Retry Only
- Currently displays instructions for **manual** retry using `/retry` command
- Does **NOT** implement interactive prompt (would require Ink components)
- User must copy/paste suggested command

### No Resubmit Function Yet
- Displays recovery options but doesn't automatically resubmit
- Relies on user running `/retry` command manually
- Future: add `/retry model=X` command support to TUI command handlers

### No Button/Selection UI
- Simple text-based instructions
- No arrow key navigation or selection
- Future: implement Ink `<SelectInput>` component for interactive selection

## Testing Plan

### Manual Test Steps

1. **Create test plugin** (`~/.openclaw/extensions/test-recover/index.js`):
```javascript
module.exports = {
  hooks: {
    run_error: async (event, ctx) => {
      return {
        action: 'switch',
        newModel: 'claude-sonnet-4.5',
        reason: 'Rate limit hit, switching to backup model'
      };
    }
  }
};
```

2. **Trigger a run error:**
   - Start TUI
   - Send a message that will fail (or mock a failure)
   - Verify recovery message appears

3. **Expected output:**
```
🔄 Recoverable Error Detected

Reason: Rate limit hit, switching to backup model

Available actions:
  • Retry with the same model
  • Switch to: claude-sonnet-4.5
  • Abort (keep error visible)

To retry manually, use:
  /retry          (same model)
  /retry model=claude-sonnet-4.5  (switch model)
```

### Automated Tests (TODO)

**File:** `src/tui/recovery-handler.test.ts`
```typescript
describe('extractRecoverySuggestion', () => {
  it('should extract suggestion from message meta', () => {
    const message = {
      meta: {
        recoverySuggestion: {
          action: 'retry',
          reason: 'transient error'
        }
      }
    };
    const result = extractRecoverySuggestion(message);
    expect(result).toEqual({
      action: 'retry',
      reason: 'transient error'
    });
  });
  
  it('should return null when no suggestion present', () => {
    expect(extractRecoverySuggestion({})).toBeNull();
    expect(extractRecoverySuggestion(null)).toBeNull();
  });
});

describe('formatRecoverySuggestion', () => {
  it('should format retry suggestion', () => {
    const suggestion = { action: 'retry', reason: 'test' };
    const result = formatRecoverySuggestion(suggestion);
    expect(result).toContain('🔄 Recoverable Error Detected');
    expect(result).toContain('Reason: test');
  });
});

describe('shouldDisplayRecoverySuggestion', () => {
  it('should not display after max attempts', () => {
    const suggestion = { action: 'retry', attempt: 3 };
    expect(shouldDisplayRecoverySuggestion(suggestion, 3)).toBe(false);
  });
  
  it('should not display fail actions', () => {
    const suggestion = { action: 'fail' };
    expect(shouldDisplayRecoverySuggestion(suggestion)).toBe(false);
  });
});
```

## Future Enhancements

### Phase 1: Command Support (Next PR)
- Add `/retry` command to TUI command handlers
- Support `/retry model=<model>` syntax
- Resubmit run with override params

### Phase 2: Interactive UI (Future PR)
- Implement Ink `<SelectInput>` component
- Show arrow-key navigable options
- Auto-submit on selection
- Real-time status updates

### Phase 3: Telemetry (Future PR)
- Track user choices (retry/switch/abort)
- Record success/failure rates
- Feed data back to Reflect plugin

## Integration with Recover v1.0 Plugin

**When Recover plugin is active:**
1. Run fails with `autoRecover=false` (default)
2. Plugin returns recovery suggestion
3. Runner adds `meta.recoverySuggestion` to run result
4. TUI event handler detects suggestion
5. Displays formatted recovery message
6. User manually retries using `/retry` command

**Flow diagram:**
```
Run fails
  ↓
Recover plugin consulted
  ↓
Returns { action: 'retry'/'switch', newModel?, reason? }
  ↓
Runner adds to meta.recoverySuggestion
  ↓
TUI detects in error event
  ↓
Displays formatted message
  ↓
User runs /retry command
  ↓
New run submitted with overrides
```

## Commit Message

```
feat(tui): add recovery suggestion display for failed runs

Implements client-side detection and display of recovery suggestions
from the run_error plugin hook (part of Recover v1.0).

Changes:
- Add recovery-handler.ts with extraction and formatting logic
- Integrate recovery detection into tui-event-handlers.ts
- Display formatted recovery instructions in error states
- Support for retry/switch suggestions with manual retry instructions

Current limitations:
- Manual retry only (user must run /retry command)
- No interactive UI (text-based instructions only)
- Requires separate PR for /retry command implementation

Part of: Recover v1.0 client integration
Related: openclaw/openclaw#20384
```

## Related Work

- **PR #20384:** `run_error` hook + runner integration
- **Next:** WebChat UI integration (similar pattern)
- **Next:** TUI command handlers for `/retry` support
- **Next:** Integration tests with mock plugin

---

**Status:** ✅ Basic TUI integration complete  
**Next Step:** Add `/retry` command support to command handlers  
**Blocker:** None (can merge as-is with manual retry workflow)
