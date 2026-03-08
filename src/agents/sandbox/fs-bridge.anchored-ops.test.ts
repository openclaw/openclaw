import { describe, expect, it } from "vitest";
import {
  createSandbox,
  createSandboxFsBridge,
  findCallByScriptFragment,
  findCallsByScriptFragment,
  getDockerArg,
  installFsBridgeTestHarness,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge anchored ops", () => {
  installFsBridgeTestHarness();

  it("anchors mkdirp operations on canonical parent + basename", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.mkdirp({ filePath: "nested/leaf" });

    const mkdirCall = findCallByScriptFragment('mkdir -p -- "$2"');
    expect(mkdirCall).toBeDefined();
    const args = mkdirCall?.[0] ?? [];
    expect(getDockerArg(args, 1)).toBe("/workspace/nested");
    expect(getDockerArg(args, 2)).toBe("leaf");
    expect(args).not.toContain("/workspace/nested/leaf");

    const canonicalCalls = findCallsByScriptFragment('readlink -f -- "$cursor"');
    expect(
      canonicalCalls.some(([callArgs]) => getDockerArg(callArgs, 1) === "/workspace/nested"),
    ).toBe(true);
  });

  it("anchors remove operations on canonical parent + basename", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.remove({ filePath: "nested/file.txt" });

    const removeCall = findCallByScriptFragment('rm -f -- "$2"');
    expect(removeCall).toBeDefined();
    const args = removeCall?.[0] ?? [];
    expect(getDockerArg(args, 1)).toBe("/workspace/nested");
    expect(getDockerArg(args, 2)).toBe("file.txt");
    expect(args).not.toContain("/workspace/nested/file.txt");

    const canonicalCalls = findCallsByScriptFragment('readlink -f -- "$cursor"');
    expect(
      canonicalCalls.some(([callArgs]) => getDockerArg(callArgs, 1) === "/workspace/nested"),
    ).toBe(true);
  });

  it("anchors rename operations on canonical parents + basenames", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.rename({ from: "from.txt", to: "nested/to.txt" });

    const renameCall = findCallByScriptFragment('mv -- "$3" "$2/$4"');
    expect(renameCall).toBeDefined();
    const args = renameCall?.[0] ?? [];
    expect(getDockerArg(args, 1)).toBe("/workspace");
    expect(getDockerArg(args, 2)).toBe("/workspace/nested");
    expect(getDockerArg(args, 3)).toBe("from.txt");
    expect(getDockerArg(args, 4)).toBe("to.txt");
    expect(args).not.toContain("/workspace/from.txt");
    expect(args).not.toContain("/workspace/nested/to.txt");
  });
});
