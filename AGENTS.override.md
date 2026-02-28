# OpenClawBot Review Overrides

These rules extend the upstream AGENTS.md for our fork.

## Review guidelines

### RPC & Distributed Systems

- Every RPC error handler must distinguish transport errors from semantic errors
- Before modifying a client-side catch block, read the server-side handler implementation
- `catch { // ignore }` comments are design signals — verify intent by checking the server contract before proposing changes
- Check if the remote operation is idempotent and retryable before adding error recovery logic
- Timeout does NOT mean failure — it means indeterminate. Handle accordingly

### Sub-agent System

- Sub-agent registry changes must include test coverage
- Announce flow failures are usually child-side preconditions (embedded runs, descendants) — the parent may be reachable via simpler mechanisms
- Fire-and-forget async calls MUST have .catch() — Node crashes on unhandled rejections
- `sessions_send` is synchronous within one agent run — do not use for async user interaction

### General

- Apply Chesterton's Fence: understand why existing code was written before changing it
- Check git blame and linked issues before modifying intentional-looking patterns
- For every proposed fix, ask: "what does the error actually represent in this system?"
- Flag any changes that assume a network error means the remote operation failed
