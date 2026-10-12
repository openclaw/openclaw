import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";

export function shouldTrackDesktopGeneration(
  startOptions: CodexAppServerStartOptions,
  pluginConfig: unknown,
): boolean {
  if (startOptions.transport !== "stdio") {
    return false;
  }
  // A managed package process can publish desktop-owned Computer Use artifacts,
  // so both share one generation. Custom operator commands remain independent.
  if (
    resolveCodexComputerUseConfig({ pluginConfig }).enabled &&
    (startOptions.commandSource === "managed" || startOptions.commandSource === "resolved-managed")
  ) {
    return true;
  }
  return (
    startOptions.commandSource === "managed" &&
    (startOptions.managedCommandOrder ?? "package-first") === "desktop-first"
  );
}
