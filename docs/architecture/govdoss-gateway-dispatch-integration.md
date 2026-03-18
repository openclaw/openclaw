# GovDOSS Gateway Dispatch Integration

## Why this layer matters

The universal server-side chokepoint for privileged execution is the gateway request dispatcher.

Current flow:

1. WebSocket connection accepted
2. Handshake and auth completed
3. Request frames parsed
4. `handleGatewayRequest(...)` authorizes role and scopes
5. A concrete gateway method handler is invoked

This means GovDOSS enforcement should be inserted between request authorization and handler invocation.

## Confirmed request path

- `src/gateway/server.impl.ts` composes the gateway runtime and handlers
- `src/gateway/server-ws-runtime.ts` attaches runtime handlers
- `src/gateway/server/ws-connection.ts` manages connections and forwards messages
- `src/gateway/server/ws-connection/message-handler.ts` parses request frames and calls `handleGatewayRequest(...)`
- `src/gateway/server-methods.ts` resolves the concrete handler and invokes it inside plugin request scope

## Required GovDOSS insertion point

Wrap the request-dispatch layer so every handler call can pass through:

1. Observe
2. Orient
3. Decide
4. Policy
5. Approval or continue
6. Act
7. Assess
8. Audit

## Scope of the wrapper

The wrapper should not replace gateway auth, protocol validation, or role/scope authorization.
Those remain in place as the first line of defense.

The GovDOSS layer should add:

- normalized request envelope
- method-based risk scoring
- policy decisions by method, role, scopes, and context
- approval interruption for high-risk methods
- SOA4 audit events before and after execution
- resumable continuation for approval-gated methods

## Initial risk grouping

### Low risk

- `health`
- `last-heartbeat`
- read-only status and inventory methods

### Medium risk

- session inspection
- non-destructive diagnostics
- browser read operations

### High risk

- `config.apply`
- `config.patch`
- `update.run`
- command execution
- node command dispatch
- browser control with side effects
- device approval and pairing actions
- send/push methods that transmit data externally

## Proposed integration pattern

Current dispatcher shape:

```ts
await withPluginRuntimeGatewayRequestScope(scope, invokeHandler)
```

Target shape:

```ts
await withPluginRuntimeGatewayRequestScope(scope, async () =>
  await govdossGatewayGuard.execute({
    req,
    client,
    context,
    executor: invokeHandler,
  })
)
```

## Guard responsibilities

### Observe

Capture:

- method
- params summary
- client identity
- role
- scopes
- remote or local origin

### Orient

Resolve:

- trust zone
- target surface
- risk tier
- whether the method is mutating or read-only

### Decide

Create a serialized decision envelope containing:

- method
- subject
- object
- risk tier
- rationale
- confidence

### Policy

Evaluate by:

- method class
- role and scopes
- runtime mode
- trust zone

### Approval

For high-risk methods, create approval request plus continuation token.

### Act

Invoke the original method handler only through the guarded executor.

### Assess

Capture outcome, response type, and failure state.

### Audit

Emit SOA4-compatible events for request start, approval creation, approval use, execution result, and denial.

## Phased implementation

### Phase 1

- create `GovdossGatewayGuard` scaffold
- map method to risk tier
- add pre/post audit emission
- no behavior change for low-risk methods

### Phase 2

- add approval interruption for high-risk methods
- add continuation and resume support for gateway methods

### Phase 3

- make guarded execution mandatory for all gateway handlers
- add bypass detection and tests

## Success criteria

- all gateway handlers become attributable and auditable
- handler execution can be interrupted before side effects
- high-risk methods require approval or explicit policy allowance
- plugins and extra handlers cannot bypass the gateway guard when dispatched through the request layer
