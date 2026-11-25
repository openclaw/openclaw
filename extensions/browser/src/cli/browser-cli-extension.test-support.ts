import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";

export async function runExtensionSetup(
  pluginRoot: string,
  action: string,
  profile?: string,
  waitMs?: number,
) {
  const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
  const program = new Command();
  registerBrowserExtensionCommands(program.command("browser"), () => ({}), pluginRoot);
  return program.parseAsync(
    [
      "browser",
      "extension",
      "setup",
      "--action",
      action,
      "--json",
      ...(profile ? ["--browser-profile", profile] : []),
      ...(waitMs === undefined ? [] : ["--wait-ms", String(waitMs)]),
    ],
    { from: "user" },
  );
}

export function createBrowserCliCapture() {
  const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
  return {
    runtime,
    resetRuntimeCapture,
    installRuntime: () => ({
      json: vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson),
      log: vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log),
      error: vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error),
      exit: vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit),
    }),
  };
}
import { Command } from "commander";
