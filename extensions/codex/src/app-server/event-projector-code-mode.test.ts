import { describe, expect, it, vi } from "vitest";
import { readCodeModeNativeCall } from "./event-projector-code-mode.js";

vi.mock("node:vm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:vm")>();
  return {
    ...actual,
    compileFunction() {
      throw new EvalError("Host string compilation is disabled");
    },
  };
});

describe("Code Mode native call syntax", () => {
  it("projects literal commands without host string compilation", () => {
    expect(
      readCodeModeNativeCall(
        'const args = {cmd: "printf hello", workdir: "/workspace"}; text(await tools.exec_command(args));',
      ),
    ).toEqual({ name: "bash", arguments: { command: "printf hello", cwd: "/workspace" } });
    const input = "*** Begin Patch\n*** Delete File: fixture.txt\n*** End Patch";
    expect(
      readCodeModeNativeCall(`text(await tools.apply_patch(${JSON.stringify(input)}));`),
    ).toEqual({
      name: "apply_patch",
      arguments: { input },
    });
  });

  it.each(["await", "yield", "eval", "arguments"])(
    "rejects the invalid strict-mode binding %s",
    (binding) => {
      expect(
        readCodeModeNativeCall(
          `const ${binding} = {cmd: "printf hello"}; text(await tools.exec_command(${binding}));`,
        ),
      ).toBeUndefined();
    },
  );
});
