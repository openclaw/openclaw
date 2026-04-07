import { afterEach, beforeEach, expect, test, vi } from "vitest";
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;

vi.mock("@lydell/node-pty", () => ({
  spawn: () => {
    const err = new Error("spawn EBADF");
    (err as NodeJS.ErrnoException).code = "EBADF";
    throw err;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.js"));
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

test("exec falls back when PTY spawn fails", async () => {
  const tool = createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
  });
  const result = await tool.execute("toolcall", {
    command: "printf ok",
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  expect(text).toContain("ok");
  expect(text).toContain("PTY spawn failed");
});
