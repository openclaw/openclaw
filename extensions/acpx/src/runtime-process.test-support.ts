import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { expect } from "vitest";
import { AcpxRuntime } from "./runtime.js";

export type RuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;
type RuntimeOptions = ConstructorParameters<typeof AcpxRuntime>[0];
export const ownerAgentScript = fileURLToPath(
  new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url),
);

export function ownerRuntimeOptions(
  root: string,
  {
    agent = "fixture",
    args = [],
    ...overrides
  }: Partial<RuntimeOptions> & { agent?: string; args?: string[] } = {},
): RuntimeOptions {
  return {
    cwd: root,
    sessionStore: overrides.sessionStore ?? createFileSessionStore({ stateDir: root }),
    agentRegistry:
      overrides.agentRegistry ??
      createAgentRegistry({
        overrides: {
          [agent]: [process.execPath, ownerAgentScript, path.join(root, "peer"), ...args],
        },
      }),
    permissionMode: "deny-all",
    timeoutMs: 5000,
    ...overrides,
  };
}

export async function copyNodeExecutable(destination: string) {
  // Symlinks preserve executable-relative libraries (including Homebrew's libnode).
  if (process.platform === "win32") {
    await fs.copyFile(process.execPath, destination);
  } else {
    await fs.symlink(process.execPath, destination);
  }
}

export async function promptJson(
  runtime: AcpxRuntime,
  handle: RuntimeHandle,
  text: string,
  requestId = text,
) {
  const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId });
  const chunks: string[] = [];
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    }
  }
  expect(await turn.result).toMatchObject({ status: "completed" });
  return JSON.parse(chunks.join(""));
}
