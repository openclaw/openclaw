import { afterEach, expect, test, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry";

afterEach(() => {
  resetProcessRegistryForTests();
  vi.resetModules();
  vi.clearAllMocks();
});

test("exec falls back when PTY spawn fails", async () => {
  vi.doMock("@lydell/node-pty", () => ({
    spawn: () => {
      const err = new Error("spawn EBADF");
      (err as NodeJS.ErrnoException).code = "EBADF";
      throw err;
    },
  }));

  const { createExecTool } = await import("./bash-tools.exec");
  const tool = createExecTool({ allowBackground: false });
  const result = await tool.execute("toolcall", {
    command: "node -e \"process.stdout.write('ok')\"",
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.[0]?.text ?? "";
  expect(text).toContain("ok");
  expect(text).toContain("PTY spawn failed");
});
