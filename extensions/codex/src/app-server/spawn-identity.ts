import { createHash } from "node:crypto";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";

/** Successful physical process identity, excluding environment and credentials. */
export type CodexAppServerClientProcessIdentity = {
  clientId: string;
  command: string;
  argsFingerprint: string;
  commandSource?: CodexAppServerStartOptions["commandSource"];
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"];
  nativeCommand?: string;
  serverVersion?: string;
  userAgent?: string;
};

export type CodexAppServerSpawnIdentity = Omit<
  CodexAppServerClientProcessIdentity,
  "clientId" | "serverVersion" | "userAgent"
>;

/** Resolves non-secret spawn identity before startup; argv is represented only by its hash. */
export function resolveCodexAppServerSpawnIdentity(
  startOptions: CodexAppServerStartOptions,
  resolvedNativeCommand?: string,
): CodexAppServerSpawnIdentity {
  const nativeCommand =
    resolvedNativeCommand ??
    (startOptions.commandSource === "resolved-managed"
      ? resolveManagedCodexNativeCommand(startOptions.command)
      : undefined);
  return {
    command: startOptions.command,
    argsFingerprint: createHash("sha256").update(JSON.stringify(startOptions.args)).digest("hex"),
    ...(startOptions.commandSource ? { commandSource: startOptions.commandSource } : {}),
    ...(startOptions.managedCommandOrder
      ? { managedCommandOrder: startOptions.managedCommandOrder }
      : {}),
    ...(nativeCommand ? { nativeCommand } : {}),
  };
}
