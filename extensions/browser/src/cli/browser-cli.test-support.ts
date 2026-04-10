import { Command } from "commander";
import type { GatewayRpcOpts } from "openclaw/plugin-sdk/browser-node-runtime";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { CliRuntimeCapture } from "../../test-support.js";

type BrowserParentOpts = GatewayRpcOpts & {
  json?: boolean;
  browserProfile?: string;
};

export function createBrowserProgram(params?: { withGatewayUrl?: boolean }): {
  program: Command;
  browser: Command;
  parentOpts: (cmd: Command) => BrowserParentOpts;
} {
  const program = new Command();
  const browser = program
    .command("browser")
    .option("--browser-profile <name>", "Browser profile")
    .option("--json", "Output JSON", false);
  if (params?.withGatewayUrl) {
    browser.option("--url <url>", "Gateway WebSocket URL");
  }
  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;
  return { program, browser, parentOpts };
}

const browserCliRuntimeState = { capture: null as CliRuntimeCapture | null };

export function getBrowserCliRuntimeCapture(): CliRuntimeCapture {
  browserCliRuntimeState.capture ??= createCliRuntimeCapture();
  return browserCliRuntimeState.capture;
}

export function getBrowserCliRuntime() {
  return getBrowserCliRuntimeCapture().defaultRuntime;
}

export async function mockBrowserCliDefaultRuntime() {
  browserCliRuntimeState.capture ??= createCliRuntimeCapture();
  return { defaultRuntime: browserCliRuntimeState.capture.defaultRuntime };
}

export async function runCommandWithRuntimeMock(
  _runtime: unknown,
  action: () => Promise<void>,
  onError: (err: unknown) => void,
) {
  return await action().catch(onError);
}

export async function createBrowserCliUtilsMockModule() {
  return { runCommandWithRuntime: runCommandWithRuntimeMock };
}

export async function createBrowserCliRuntimeMockModule() {
  return await mockBrowserCliDefaultRuntime();
}
