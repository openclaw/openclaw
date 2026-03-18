# Gateway Governance Enforcement Plan

## Goal

Make the gateway the mandatory enforcement surface for all privileged actions so that no plugin, node, or operator path can bypass GovDOSS controls.

## Required invariants

1. All privileged execution routes through `GovdossRuntime`.
2. All high-risk actions produce approval requests before execution.
3. All privileged actions emit SOA4 audit events before and after execution.
4. All action adapters are invoked through explicit execution envelopes.

## Enforcement points

### Ingress

At channel or tool ingress, normalize requests into:

- subject
- workspace
n- session
- requested action
- target surface

### Runtime binding

The gateway should instantiate one shared governance runtime per workspace or policy context and require execution through that runtime.

### Adapter boundary

Browser, node, shell, and file adapters should be wrapped so that the gateway calls the adapter only from inside a governed executor callback.

### Approval continuation

When approval is required, the gateway should persist the request and return a continuation token. Resumed execution must re-enter the runtime using that token.

## Migration sequence

1. wrap operator execution
2. wrap browser execution
3. wrap node and command execution
4. add lint checks for bypass patterns
5. make direct adapter usage a failing review condition

## Success condition

The gateway becomes the single place where policy, risk, approval, audit, and execution meet.
