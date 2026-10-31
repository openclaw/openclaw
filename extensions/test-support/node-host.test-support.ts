import { vi } from "vitest";

type NodeHostRuntime = typeof import("openclaw/plugin-sdk/node-host");

export function createNodeHostMocks(options: { userShellFallback?: boolean } = {}) {
  const fixture = {
    runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
    userShellPaths: new Map<string, string>(),
  };
  return Object.assign(fixture, {
    mockRuntime: async (importOriginal: <T>() => Promise<T>) => {
      const actual = await importOriginal<NodeHostRuntime>();
      return {
        ...actual,
        runNodePtyCommand: fixture.runNodePtyCommand,
        resolveNodeHostExecutable: (
          command: string,
          params: Parameters<NodeHostRuntime["resolveNodeHostExecutable"]>[1],
        ) => {
          const env = params.env ?? process.env;
          const pathEnv = params.pathEnv ?? env.PATH ?? env.Path ?? "";
          const direct = actual.resolveNodeHostExecutable(command, {
            env,
            pathEnv,
            includeExtensionless: params.includeExtensionless,
            strategy: "direct",
          });
          if (!options.userShellFallback || (direct && params.strategy !== "prefer")) {
            return direct;
          }
          const shellPath = fixture.userShellPaths.get(command);
          if (!shellPath) {
            return direct;
          }
          const shellExecutable = actual.resolveNodeHostExecutable(command, {
            env,
            pathEnv: shellPath,
            includeExtensionless: params.includeExtensionless,
            strategy: "direct",
          });
          return shellExecutable
            ? { executable: shellExecutable.executable, pathEnv: shellPath }
            : direct;
        },
      };
    },
  });
}
