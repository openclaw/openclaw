# Fix Verification for Issue #48121

## Issue
**Switching agents does not update avatar until manual refresh**

When switching agents in the Control UI, the avatar stays on the previous agent's avatar until the page is manually refreshed (F5).

## Root Cause
The `refreshChatAvatar()` function was only called during:
- Initial connection
- Session reset  
- Session selection

But **NOT** during agent switching (`onAgentChange` callback).

## Fix Applied
Added `void refreshChatAvatar(state);` to the `onAgentChange` callback in `ui/src/ui/app-render.ts`.

### Code Change
```typescript
onAgentChange: (agentId: string) => {
  state.sessionKey = buildAgentMainSessionKey({ agentId });
  state.chatMessages = [];
  state.chatStream = null;
  state.chatRunId = null;
  state.applySettings({
    ...state.settings,
    sessionKey: state.sessionKey,
    lastActiveSessionKey: state.sessionKey,
  });
  void loadChatHistory(state);
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);  // ← ADDED THIS LINE
},
```

## Testing Steps

### Manual Testing
1. Configure two agents with different avatars in IDENTITY.md
2. Start OpenClaw Gateway
3. Open Control UI
4. Switch between agents
5. **Expected**: Avatar updates immediately
6. **Before fix**: Avatar required manual refresh (F5)

### Code Verification
- ✅ Syntax check passed (node --check)
- ✅ Function `refreshChatAvatar` is already imported in app-render.ts
- ✅ Same pattern used in other callbacks (session reset, session select)
- ✅ Minimal change (1 line added)

## Files Modified
- `ui/src/ui/app-render.ts` (1 line added)

## Related
- Issue: #48121
- PR: #48131

## Test Environment
- Node.js: v22.22.1
- OpenClaw: 2026.3.13
- Branch: fix/agent-switch-avatar-refresh
