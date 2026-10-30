import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { runWithSessionMcpToolCallAuthority } from "./agent-bundle-mcp-request-context.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const REQUEST_OPERATIONS = new Set<PropertyKey>([
  "getCatalog",
  "callTool",
  "listTools",
  "listResources",
  "readResource",
  "listResourceTemplates",
  "listPrompts",
  "getPrompt",
]);

/** A turn-owned view must not install its guard on a cached runtime used by later turns. */
export function createMcpRunView(
  runtime: SessionMcpRuntime,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): SessionMcpRuntime {
  if (!assertCurrent) {
    return runtime;
  }
  const assertActive = () => {
    signal?.throwIfAborted();
    assertCurrent();
  };
  const run = <T>(request: () => Promise<T>) =>
    withGuardedFetchRequestAuthority(assertActive, async () => {
      const result = await runWithSessionMcpToolCallAuthority(assertActive, request);
      assertActive();
      return result;
    });
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "requesterConnect") {
        const connect = target.requesterConnect;
        return (
          connect && {
            ...connect,
            get catalog() {
              return connect.catalog;
            },
            createExecute(serverName: string) {
              const execute = connect.createExecute(serverName, { assertCurrent: assertActive });
              return (
                execute && ((...args: Parameters<typeof execute>) => run(() => execute(...args)))
              );
            },
          }
        );
      }
      const value = Reflect.get(target, key, target);
      if (REQUEST_OPERATIONS.has(key) && typeof value === "function") {
        return (...args: unknown[]) => run(async () => Reflect.apply(value, target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
