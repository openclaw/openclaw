import { afterEach, expect, test } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("exec supports pty output", async () => {
  const tool = createExecTool({ allowBackground: false, security: "full", ask: "off" });
  const result = await tool.execute("toolcall", {
    command: 'node -e "process.stdout.write(String.fromCharCode(111,107))"',
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  expect(text).toContain("ok");
});

test("exec sets OPENCLAW_SHELL in pty mode", async () => {
  const tool = createExecTool({ allowBackground: false, security: "full", ask: "off" });
  const result = await tool.execute("toolcall-openclaw-shell", {
    command: "node -e \"process.stdout.write(process.env.OPENCLAW_SHELL || '')\"",
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  expect(text).toContain("exec");
});
