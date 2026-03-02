# Hook System Comparison: OpenClaw vs pi-mono vs Claude Code

## Agent Lifecycle Hooks

| Event | OpenClaw | pi-mono | Claude Code | When it fires | Can block/modify? |
|-------|----------|---------|-------------|---------------|-------------------|
| **User Input** | ❌ | `input` | `UserPromptSubmit` | When user submits a prompt | pi-mono: can intercept/transform<br>Claude: Yes (can block) |
| **Before Agent Start** | `before_agent_start` | `before_agent_start` | ❌ | After input, before LLM call | OpenClaw: can inject message/modify system prompt<br>pi-mono: can inject message/modify system prompt |
| **Agent Start** | `llm_input` | `agent_start` | ❌ | When agent loop begins | No (observe only) |
| **LLM Input** | `llm_input` | ❌ | ❌ | Before payload sent to LLM | No (observe exact payload) |
| **LLM Output** | `llm_output` | ❌ | ❌ | After LLM responds | No (observe exact response) |
| **Agent End** | `agent_end` | `agent_end` | `Stop` | When agent finishes responding | **OpenClaw (with PR):** can force continue<br>**pi-mono:** No (but can call sendUserMessage)<br>**Claude Code:** Yes (forces continue) |

## Turn/Streaming Hooks

| Event | OpenClaw | pi-mono | Claude Code | When it fires | Can block/modify? |
|-------|----------|---------|-------------|---------------|-------------------|
| **Turn Start** | ❌ | `turn_start` | ❌ | Start of each turn (LLM response cycle) | No (observe) |
| **Turn End** | ❌ | `turn_end` | ❌ | End of each turn | No (observe) |
| **Message Start** | ❌ | `message_start` | ❌ | When message starts streaming | No (observe) |
| **Message Update** | ❌ | `message_update` | ❌ | Token-by-token streaming updates | No (observe) |
| **Message End** | ❌ | `message_end` | ❌ | When message finishes streaming | No (observe) |
| **Context Modification** | `before_prompt_build` | `context` | ❌ | Before messages sent to LLM | Yes (can modify message array) |

## Tool Execution Hooks

| Event | OpenClaw | pi-mono | Claude Code | When it fires | Can block/modify? |
|-------|----------|---------|-------------|---------------|-------------------|
| **Before Tool Call** | `before_tool_call` | `tool_call` | `PreToolUse` | Before a tool executes | Yes (can block) |
| **Tool Execution Start** | ❌ | `tool_execution_start` | ❌ | When tool starts running | No (observe) |
| **Tool Execution Update** | ❌ | `tool_execution_update` | ❌ | Tool progress updates | No (observe) |
| **Tool Execution End** | ❌ | `tool_execution_end` | ❌ | When tool finishes | No (observe) |
| **After Tool Call** | `after_tool_call` | ❌ | `PostToolUse` | After tool succeeds | No (already ran) |
| **Tool Result** | `tool_result_persist` | `tool_result` | ❌ | Before result written to transcript | Yes (can modify result) |

## Session Lifecycle Hooks

| Event | OpenClaw | pi-mono | Claude Code | When it fires | Can block/modify? |
|-------|----------|---------|-------------|---------------|-------------------|
| **Session Start** | `session_start` | `session_start` | `SessionStart` | Session begins/resumes | No (observe) |
| **Session End** | `session_end` | `session_shutdown` | ❌ | Session ends | No (observe) |
| **Before Switch** | ❌ | `session_before_switch` | ❌ | Before switching sessions | Yes (can cancel) |
| **Session Switch** | ❌ | `session_switch` | ❌ | After switch completes | No (observe) |
| **Before Fork** | ❌ | `session_before_fork` | ❌ | Before forking session | Yes (can cancel) |
| **Session Fork** | ❌ | `session_fork` | ❌ | After fork completes | No (observe) |
| **Before Compact** | `before_compaction` | `session_before_compact` | ❌ | Before compaction runs | Yes (can cancel/customize) |
| **After Compact** | `after_compaction` | `session_compact` | ❌ | After compaction completes | No (observe) |
| **Before Reset** | `before_reset` | ❌ | ❌ | Before session reset | Yes (can cancel) |
| **Before Tree Navigation** | ❌ | `session_before_tree` | ❌ | Before navigating session tree | Yes (can cancel) |
| **Tree Navigation** | ❌ | `session_tree` | ❌ | After tree nav completes | No (observe) |

## Channel/Messaging Hooks

| Event | OpenClaw | pi-mono | Claude Code | When it fires | Can block/modify? |
|-------|----------|---------|-------------|---------------|-------------------|
| **Message Received** | `message_received` | ❌ | ❌ | Inbound message from channel | No (observe) |
| **Message Sending** | `message_sending` | ❌ | ❌ | Before outbound message sent | Yes (can modify) |
| **Message Sent** | `message_sent` | ❌ | ❌ | After message successfully sent | No (observe) |
| **Before Message Write** | `before_message_write` | ❌ | ❌ | Before message written to transcript | Yes (can modify) |

## Gateway/System Hooks

| Event | OpenClaw | pi-mono | Claude Code | When it fires | Can block/modify? |
|-------|----------|---------|-------------|---------------|-------------------|
| **Gateway Start** | `gateway_start` | ❌ | ❌ | After channels start, hooks loaded | No (observe) |
| **Gateway Stop** | `gateway_stop` | ❌ | ❌ | Before gateway shutdown | No (cleanup) |
| **Before Model Resolve** | `before_model_resolve` | `model_select` | ❌ | Before model is selected | Yes (can override model) |

## Claude Code Specific Hooks

| Event | OpenClaw Equivalent | pi-mono Equivalent | When it fires | Can block/modify? |
|-------|---------------------|-------------------|---------------|-------------------|
| **SubagentStart** | ❌ | ❌ | When subagent spawns | No |
| **SubagentStop** | ❌ | ❌ | When subagent finishes | Yes (forces continue) |
| **TaskCompleted** | ❌ | ❌ | When task marked complete | Yes (can block) |
| **TeammateIdle** | ❌ | ❌ | When teammate about to idle | Yes (can block) |
| **Notification** | ❌ | ❌ | System notification | No (trigger action) |

## pi-mono Specific Hooks

| Event | OpenClaw Equivalent | Claude Code Equivalent | When it fires | Can block/modify? |
|-------|---------------------|----------------------|---------------|-------------------|
| **user_bash** | ❌ | ❌ | User-initiated bash command | Yes (can block) |
| **resources_discover** | ❌ | ❌ | Resource discovery phase | Yes (can add resources) |

## Key Differences

### Execution Model

**Claude Code:**
- Hooks can be shell commands or LLM prompts
- Exit code controls behavior (0=allow, 1=warn, 2=block)
- Prompt hooks send context to fast model for judgment
- Synchronous blocking for critical hooks

**pi-mono:**
- TypeScript extension functions
- Sequential execution (await per-handler)
- Can call runtime methods (sendUserMessage, etc.)
- Rich context object with UI and session access

**OpenClaw:**
- TypeScript plugin functions
- Currently parallel execution (Promise.all)
- Return values for blocking hooks
- Gateway-level hook runner

### Anti-Rationalization Pattern

**Claude Code (Stop hook):**
```json
{
  "type": "prompt",
  "prompt": "Review assistant response. Return {ok: false, reason: '...'} to force continue."
}
```

**pi-mono (agent_end + sendUserMessage):**
```typescript
api.on('agent_end', async (event, ctx) => {
  if (isIncomplete(event.messages)) {
    await ctx.sendUserMessage('Continue with the task.');
  }
});
```

**OpenClaw (with PR #21874):**
```typescript
api.on('agent_end', async (event, ctx) => {
  if (isIncomplete(event.messages)) {
    return {
      continue: true,
      message: 'Continue with the task.'
    };
  }
});
```

## Coverage Summary

| Feature | OpenClaw | pi-mono | Claude Code |
|---------|----------|---------|-------------|
| Agent lifecycle | ✅ Basic | ✅ Complete | ⚠️ Basic (Stop only) |
| Turn/streaming events | ❌ | ✅ Complete | ❌ |
| Tool execution lifecycle | ⚠️ Before/After only | ✅ Complete | ⚠️ Before/After only |
| Session management | ⚠️ Basic | ✅ Complete | ⚠️ Basic |
| Channel/messaging | ✅ OpenClaw specific | ❌ | ❌ |
| Anti-rationalization | 🚧 PR in progress | ⚠️ Via sendUserMessage | ✅ Stop hook |
| Model selection | ✅ before_model_resolve | ✅ model_select | ❌ |
| Compaction control | ✅ before/after | ✅ before/after | ❌ |

## Recommendations for OpenClaw

### High Priority (Missing from pi-mono)
1. ✅ **agent_end with continue support** (PR #21874 in progress)
2. ❌ **Turn events** (`turn_start`, `turn_end`) - helpful for debugging
3. ❌ **Context modification** (pi-mono's `context` hook) - already have `before_prompt_build`
4. ❌ **Tool execution events** (`tool_execution_start/update/end`) - observability

### Medium Priority
5. ❌ **Message streaming events** (`message_start/update/end`) - progress feedback
6. ❌ **Input interception** (pi-mono's `input`) - pre-processing
7. ❌ **Session before-events** (before_switch, before_fork, before_tree) - user confirmations

### Low Priority (Nice to have)
8. ❌ **User bash hook** - specific to pi-mono's bash tool
9. ❌ **Resources discover** - specific to pi-mono's resource system

### Already Better Than pi-mono
- ✅ Channel-level hooks (`message_received/sent`)
- ✅ Gateway lifecycle hooks
- ✅ LLM input/output observation
- ✅ Message write interception
