# Gateway channel lifecycle (startAccount contract)

This spec describes how the gateway runs channel providers and when it
considers a channel "running" or "stopped". Extension channel plugins that
implement `gateway.startAccount` must follow this contract so the gateway and
health monitor behave correctly.

## Contract: startAccount promise

`plugin.gateway.startAccount(ctx)` is invoked when the gateway starts a channel
account. It must return a **Promise** that:

- **Stays pending** while the channel is running (server listening, bot
  connected, etc.).
- **Resolves or rejects** only when the channel is shutting down (e.g. user
  stopped the channel, abort signal fired, or fatal error).

When the promise **settles** (resolves or rejects), the gateway:

1. Sets the account runtime to `running: false` and `lastStopAt`.
2. Runs auto-restart logic: logs `auto-restart attempt N/10 in Xs`, waits for
   backoff, then calls `startChannel` again (unless the account was manually
   stopped or max attempts reached).

So if `startAccount` returns a promise that **resolves as soon as the server has
started** (e.g. right after `httpServer.listen(port)`), the gateway will treat
the channel as "exited" immediately and enter a restart loop.

## Correct pattern (long-lived server)

For a channel that runs an HTTP server or similar long-lived process:

1. Start the server (or connection).
2. Return a Promise that **does not resolve** until the process should stop.
3. When the gateway aborts (e.g. user stops the channel), `ctx.abortSignal`
   fires. In the abort listener: perform shutdown (close server, disconnect),
   then **resolve** the promise so the gateway’s `await task` in `stopChannel`
   can complete.

Example shape:

```ts
// Pseudocode
const result = { app, shutdown };

if (opts.abortSignal) {
  return new Promise((resolve) => {
    opts.abortSignal.addEventListener(
      "abort",
      () => {
        void shutdown().then(() => resolve(result));
      },
      { once: true },
    );
  });
}
return new Promise(() => {}); // no abort: never resolve
```

## MS Teams fix (historical)

The MS Teams extension previously returned from `monitorMSTeamsProvider` with
`{ app, shutdown }` as soon as `expressApp.listen(port)` was called. That made
the `startAccount` promise resolve immediately, so the gateway repeatedly
logged "auto-restart attempt N/10" and restarted the provider. The fix was to
return a promise that stays pending until `opts.abortSignal` fires and
`shutdown()` has completed, then resolve with the same result.

## References

- Gateway channel manager: `src/gateway/server-channels.ts` (task handling,
  auto-restart).
- Health monitor: `src/gateway/channel-health-monitor.ts` (periodic check of
  `running`, optional restart).
- MS Teams provider: `extensions/msteams/src/monitor.ts`
  (`monitorMSTeamsProvider`).
