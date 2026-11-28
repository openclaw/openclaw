import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";

// API and runtime bundles must carry the same invocation assertion.
const requestAuthority = resolveGlobalSingleton(
  Symbol.for("openclaw.discord.requestAuthority"),
  () => new AsyncLocalStorage<() => void>(),
);

/** Carry the host's existing assertion without changing its lifetime or ownership. */
export function withDiscordRequestAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: () => T,
): T {
  if (!assertCurrent) {
    return run();
  }
  const inherited = requestAuthority.getStore();
  return requestAuthority.run(
    inherited && inherited !== assertCurrent
      ? () => {
          inherited();
          assertCurrent();
        }
      : assertCurrent,
    run,
  );
}

export function captureDiscordRequestAuthority(): (() => void) | undefined {
  return requestAuthority.getStore();
}
