import { afterEach, expect, test, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry";
import { createExecTool, setPtyModuleLoaderForTests } from "./bash-tools.exec";

afterEach(() => {
  resetProcessRegistryForTests();
  setPtyModuleLoaderForTests();
  vi.clearAllMocks();
});

test("exec falls back when PTY spawn fails", async () => {
  setPtyModuleLoaderForTests(async () => ({
    spawn: () => {
      const err = new Error("spawn EBADF");
      (err as NodeJS.ErrnoException).code = "EBADF";
      throw err;
    },
  }));

  const tool = createExecTool({ allowBackground: false });
  const result = await tool.execute("toolcall", {
    command: "printf ok",
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.[0]?.text ?? "";
  expect(text).toContain("ok");
  expect(text).toContain("PTY spawn failed");
});
