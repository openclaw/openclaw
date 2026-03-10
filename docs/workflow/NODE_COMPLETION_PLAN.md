# Workflow Nodes Completion Plan

**Created:** March 9, 2026
**Status:** 📋 Planning Phase
**Target:** Complete all stub node implementations

---

## Overview

Four workflow nodes are currently implemented as stubs (placeholders). This plan outlines the work needed to complete each node with full functionality.

### Current Status

| Node              | Status  | Priority | Complexity      |
| ----------------- | ------- | -------- | --------------- |
| **Execute Tool**  | ⚠️ Stub | High     | Medium          |
| **Remote Invoke** | ⚠️ Stub | High     | Medium          |
| **TTS (Speak)**   | ⚠️ Stub | Medium   | Low             |
| **Custom JS**     | ⚠️ Stub | Low      | High (security) |

---

## Phase 1: Execute Tool Node

**Goal:** Enable workflow execution of catalog tools

### Tasks

#### 1.1 Research & Design (2-3 days)

- [ ] Research tool catalog architecture
- [ ] Identify tool execution APIs
- [ ] Design tool argument validation
- [ ] Plan error handling strategy

**Files to Review:**

- `src/tools/` - Tool catalog structure
- `src/agents/tools.ts` - Tool integration patterns
- `src/cli/tools.ts` - CLI tool execution

**Key Questions:**

- How are tools registered and discovered?
- What's the execution interface?
- How are tool results returned?
- What permissions are required?

#### 1.2 Implementation (3-4 days)

- [ ] Update `execute-tool.ts` handler
- [ ] Add tool discovery/validation
- [ ] Implement tool execution
- [ ] Handle tool results and errors

**Implementation Details:**

```typescript
// execute-tool.ts structure
export const executeToolHandler: WorkflowNodeHandler = {
  actionType: "execute-tool",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    // 1. Validate tool exists
    // 2. Validate arguments match tool schema
    // 3. Execute tool with context
    // 4. Return formatted result
  },
};
```

#### 1.3 Testing (1-2 days)

- [ ] Write unit tests
- [ ] Test with sample tools
- [ ] Test error scenarios
- [ ] Integration test with workflows

### Deliverables

- ✅ Working Execute Tool node
- ✅ Tool validation
- ✅ Error handling
- ✅ Unit tests
- ✅ Documentation update

---

## Phase 2: Remote Invoke Node

**Goal:** Enable workflow execution of commands on paired nodes

### Tasks

#### 2.1 Research & Design (2-3 days)

- [ ] Research `node.invoke` gateway method
- [ ] Understand node pairing/availability
- [ ] Design command validation
- [ ] Plan timeout/error handling

**Files to Review:**

- `src/gateway/server-methods/nodes.ts` - Node methods
- `src/nodes/` - Node protocol
- `docs/nodes/index.md` - Node documentation

**Key Questions:**

- How to check node availability?
- What commands are allowed?
- How to handle node disconnection?
- What's the timeout strategy?

#### 2.2 Implementation (3-4 days)

- [ ] Update `remote-invoke.ts` handler
- [ ] Add node availability check
- [ ] Implement `node.invoke` call
- [ ] Handle responses and errors

**Implementation Details:**

```typescript
// remote-invoke.ts structure
export const remoteInvokeHandler: WorkflowNodeHandler = {
  actionType: "remote-invoke",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    // 1. Validate target node exists and is connected
    // 2. Validate command is allowed
    // 3. Invoke command on node
    // 4. Wait for response with timeout
    // 5. Return result or error
  },
};
```

#### 2.3 Testing (1-2 days)

- [ ] Write unit tests
- [ ] Test with mock node
- [ ] Test timeout scenarios
- [ ] Test disconnection handling

### Deliverables

- ✅ Working Remote Invoke node
- ✅ Node availability checks
- ✅ Command validation
- ✅ Timeout handling
- ✅ Unit tests

---

## Phase 3: TTS (Speak) Node

**Goal:** Enable text-to-speech conversion in workflows

### Tasks

#### 3.1 Research & Design (1-2 days)

- [ ] Research `tts.convert` gateway method
- [ ] Understand TTS provider integration
- [ ] Design voice/provider validation
- [ ] Plan audio delivery (file/url)

**Files to Review:**

- `src/tts/` - TTS service implementation
- `src/gateway/server-methods/tts.ts` - TTS methods
- `docs/tts.md` - TTS documentation

**Key Questions:**

- What TTS providers are supported?
- How is audio returned (file path, URL, base64)?
- How to handle provider failures?
- What are the rate limits?

#### 3.2 Implementation (2-3 days)

- [ ] Update `tts.ts` handler
- [ ] Add voice/provider validation
- [ ] Implement TTS conversion call
- [ ] Handle audio output

**Implementation Details:**

```typescript
// tts.ts structure
export const ttsHandler: WorkflowNodeHandler = {
  actionType: "tts",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    // 1. Validate text input
    // 2. Validate voice/provider
    // 3. Call tts.convert
    // 4. Return audio file path or URL
  },
};
```

#### 3.3 Testing (1 day)

- [ ] Write unit tests
- [ ] Test with different voices
- [ ] Test provider fallback
- [ ] Test long text handling

### Deliverables

- ✅ Working TTS node
- ✅ Voice selection
- ✅ Provider support
- ✅ Audio output handling
- ✅ Unit tests

---

## Phase 4: Custom JS Node

**Goal:** Enable secure JavaScript execution in workflows

⚠️ **Security Critical** - Requires careful design and review

### Tasks

#### 4.1 Security Design (3-5 days)

- [ ] Design secure execution sandbox
- [ ] Identify security risks
- [ ] Plan resource limits (CPU, memory, time)
- [ ] Review with security team

**Security Considerations:**

- No access to `require()`, `process`, `global`
- Timeout enforcement (max 5 seconds)
- Memory limits
- No network access
- No file system access
- Sandboxed evaluation context

**Options:**

1. **Node.js `vm` module** - Built-in, but requires careful setup
2. **QuickJS** - Complete isolation, but adds dependency
3. **Restricted Function** - Simple, but limited

#### 4.2 Implementation (4-6 days)

- [ ] Update `custom-js.ts` handler
- [ ] Implement sandboxed execution
- [ ] Add timeout enforcement
- [ ] Add resource limits
- [ ] Handle errors safely

**Implementation Details:**

```typescript
// custom-js.ts structure
export const customJSHandler: WorkflowNodeHandler = {
  actionType: "custom-js",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    // 1. Validate code (no dangerous patterns)
    // 2. Create isolated context
    // 3. Execute with timeout
    // 4. Return result or error
  },
};
```

#### 4.3 Security Review (2-3 days)

- [ ] Internal security audit
- [ ] Penetration testing
- [ ] Fix identified issues
- [ ] Document security boundaries

#### 4.4 Testing (2 days)

- [ ] Write unit tests
- [ ] Test sandbox escapes (attempt)
- [ ] Test timeout enforcement
- [ ] Test resource limits

### Deliverables

- ✅ Working Custom JS node (with security review)
- ✅ Secure sandbox
- ✅ Resource limits
- ✅ Timeout enforcement
- ✅ Security documentation
- ✅ Unit tests

---

## Phase 5: Integration & Testing

### Tasks

#### 5.1 Server-Cron Integration (2 days)

- [ ] Update `server-cron.ts` to use `executeWorkflowChain`
- [ ] Remove old inline execution logic
- [ ] Add logging and monitoring
- [ ] Test with existing workflows

#### 5.2 End-to-End Testing (3-4 days)

- [ ] Test complete workflow scenarios
- [ ] Test branching logic
- [ ] Test error recovery
- [ ] Performance testing
- [ ] Load testing

#### 5.3 Documentation Updates (1 day)

- [ ] Update `nodes-reference.md` status
- [ ] Add usage examples
- [ ] Update migration guide
- [ ] Create troubleshooting guide

---

## Timeline

### Phase 1: Execute Tool

- **Start:** Week 1
- **Duration:** 6-9 days
- **End:** Week 2

### Phase 2: Remote Invoke

- **Start:** Week 2
- **Duration:** 6-9 days
- **End:** Week 3

### Phase 3: TTS

- **Start:** Week 3
- **Duration:** 4-6 days
- **End:** Week 4

### Phase 4: Custom JS

- **Start:** Week 4
- **Duration:** 11-16 days (includes security review)
- **End:** Week 6

### Phase 5: Integration

- **Start:** Week 6
- **Duration:** 6-8 days
- **End:** Week 7

**Total Estimated Duration:** 7 weeks

---

## Resource Requirements

### Development

- 1-2 backend engineers
- 1 frontend engineer (UI updates if needed)

### Security Review

- Security team review (Custom JS only)
- Penetration testing (Custom JS only)

### Infrastructure

- Test environment with nodes paired
- TTS API keys for testing
- Tool catalog access

---

## Risk Assessment

### High Risk

- **Custom JS Security:** Potential sandbox escape
  - **Mitigation:** Thorough security review, restricted feature set

### Medium Risk

- **Remote Invoke Reliability:** Node disconnection during execution
  - **Mitigation:** Timeout handling, retry logic

### Low Risk

- **TTS Provider Availability:** API rate limits or outages
  - **Mitigation:** Provider fallback, error handling

---

## Success Criteria

### Functional

- ✅ All 4 nodes execute correctly
- ✅ Error handling works as expected
- ✅ Integration with existing workflows seamless

### Quality

- ✅ Unit test coverage >80%
- ✅ Integration test coverage >60%
- ✅ No critical security issues

### Documentation

- ✅ All nodes documented in `nodes-reference.md`
- ✅ Usage examples provided
- ✅ Troubleshooting guide available

---

## Next Steps

1. **Prioritize phases** with team
2. **Assign owners** to each phase
3. **Set up development environment**
4. **Begin Phase 1: Execute Tool**

---

## Appendix: Current Stub Files

- `src/gateway/workflow-nodes/execute-tool.ts`
- `src/gateway/workflow-nodes/remote-invoke.ts`
- `src/gateway/workflow-nodes/tts.ts`
- `src/gateway/workflow-nodes/custom-js.ts`

---

**Last Updated:** March 9, 2026
**Version:** 1.0
