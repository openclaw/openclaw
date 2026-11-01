import { expect, it, vi } from "vitest";

const { resolveNodeMock } = vi.hoisted(() => ({ resolveNodeMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  resolveNodeRuntimeExecutable: resolveNodeMock,
}));

import { resolveQaNodeExecPath } from "./node-exec.js";

it("explains the QA prerequisite when the shared resolver cannot find Node", async () => {
  resolveNodeMock.mockReturnValue(undefined);
  await expect(resolveQaNodeExecPath()).rejects.toThrow(
    "Node not found in PATH. QA live lanes require Node for child gateway and CLI processes.",
  );
});
