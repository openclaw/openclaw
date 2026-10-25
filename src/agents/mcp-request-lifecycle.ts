import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";

export function createMcpRequestLifecycle(humanInputTimeoutMs: number) {
  const timeouts = new WeakSet<object>();
  return {
    didTimeout: (error: unknown) =>
      error !== null && typeof error === "object" && timeouts.has(error),
    run: async <T>(
      { requestTimeoutMs: timeoutMs }: { requestTimeoutMs: number },
      request: (signal: AbortSignal, holdForHumanInput: () => () => void) => Promise<T>,
      parentSignal?: AbortSignal,
    ): Promise<T> => {
      const requestSignal = parentSignal ?? getSessionMcpRequestSignal();
      let deadline = Date.now() + timeoutMs;
      const { SdkError, SdkErrorCode } = await import("@modelcontextprotocol/client");
      requestSignal?.throwIfAborted();
      const abortController = new AbortController();
      const signal = requestSignal
        ? AbortSignal.any([requestSignal, abortController.signal])
        : abortController.signal;
      const timeoutError = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", {
        timeout: timeoutMs,
      });
      const onTimeout = () => {
        timeouts.add(timeoutError);
        abortController.abort(timeoutError);
      };
      let humanInputRemainingMs = humanInputTimeoutMs;
      let humanInputStartedAt = 0;
      let humanInputWaits = 0;
      let finished = false;
      let timeout = setTimeout(onTimeout, Math.max(0, deadline - Date.now()));
      timeout.unref?.();
      const armTimeout = (expiresAt: number) => {
        clearTimeout(timeout);
        timeout = setTimeout(onTimeout, Math.max(0, expiresAt - Date.now()));
        timeout.unref?.();
      };
      const holdForHumanInput = () => {
        if (humanInputWaits++ === 0) {
          humanInputStartedAt = Date.now();
          armTimeout(deadline + humanInputRemainingMs);
        }
        return () => {
          if (--humanInputWaits === 0 && !finished && !signal.aborted) {
            const elapsed = Math.min(Date.now() - humanInputStartedAt, humanInputRemainingMs);
            humanInputRemainingMs -= elapsed;
            deadline += elapsed;
            armTimeout(deadline);
          }
        };
      };
      try {
        if (Date.now() >= deadline) {
          onTimeout();
        }
        signal.throwIfAborted();
        const result = await request(signal, holdForHumanInput);
        requestSignal?.throwIfAborted();
        return result;
      } catch (error) {
        requestSignal?.throwIfAborted();
        throw error;
      } finally {
        finished = true;
        clearTimeout(timeout);
      }
    },
  };
}
