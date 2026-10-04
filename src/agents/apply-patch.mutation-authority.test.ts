import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryPatchSandbox } from "./apply-patch.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

it.each(["create", "remove"] as const)(
  "rechecks patch authority after %s preparation",
  async (operation) => {
    const root = await fs.realpath(tempDirs.make("openclaw-patch-authority-"));
    const existing = path.join(root, "existing.txt");
    await fs.writeFile(existing, "original\n");
    const target = operation === "create" ? path.join(root, "nested", "new.txt") : existing;
    let current = true;
    let prepared = false;
    const revoke = async () => {
      await Promise.resolve();
      current = false;
      prepared = true;
    };
    __setFsSafeTestHooksForTest({
      beforePinnedWriteParentAdmission: async (targetPath) => {
        if (operation === "create" && targetPath === target) {
          await revoke();
        }
      },
      beforeRootFallbackMutation: async (kind, targetPath) => {
        if (kind === operation && targetPath === target) {
          await revoke();
        }
      },
    });

    const tool = createApplyPatchTool({ cwd: root });
    const input =
      operation === "create"
        ? "*** Begin Patch\n*** Add File: nested/new.txt\n+new\n*** End Patch"
        : "*** Begin Patch\n*** Delete File: existing.txt\n*** End Patch";
    const pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:patch-authority",
        receiptAuthority: () => current,
      },
      () => tool.execute("patch-authority", { input }),
    );

    await expect(pending).rejects.toThrow("authority is no longer active");
    expect(prepared).toBe(true);
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("original\n");
    await expect(fs.readdir(root)).resolves.toEqual(["existing.txt"]);
  },
);

it("passes the captured authority fence to every sandbox bridge mutation", async () => {
  const memory = createMemoryPatchSandbox({ "old.txt": "old\n", "edit.txt": "before\n" });
  const tool = createApplyPatchTool({
    cwd: "/local/workspace",
    sandbox: { root: "/sandbox", bridge: memory.bridge },
  });
  await withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:patch-fence", receiptAuthority: () => true },
    () =>
      tool.execute("sandbox-fence", {
        input: [
          "*** Begin Patch",
          "*** Add File: nested/new.txt",
          "+new",
          "*** Delete File: old.txt",
          "*** Update File: edit.txt",
          "@@",
          "-before",
          "+after",
          "*** End Patch",
        ].join("\n"),
      }),
  );
  const allFenced = (calls: unknown[][]) =>
    calls.every(
      ([params]) =>
        typeof (params as { assertBeforeMutation?: unknown }).assertBeforeMutation === "function",
    );
  expect(memory.createFileExclusive).toHaveBeenCalled();
  expect(memory.remove).toHaveBeenCalled();
  expect(memory.writeFile).toHaveBeenCalled();
  for (const mock of [memory.createFileExclusive, memory.remove, memory.writeFile, memory.mkdirp]) {
    expect(allFenced(mock.mock.calls)).toBe(true);
  }
});

it("stops a sandbox patch write when the fence throws inside the bridge", async () => {
  const memory = createMemoryPatchSandbox({ "edit.txt": "before\n" });
  let current = true;
  memory.writeFile.mockImplementation(async (params: { assertBeforeMutation?: () => void }) => {
    await Promise.resolve();
    current = false; // revoked during the bridge's own awaited preparation
    params.assertBeforeMutation?.();
    throw new Error("write reached the final effect");
  });
  const tool = createApplyPatchTool({
    cwd: "/local/workspace",
    sandbox: { root: "/sandbox", bridge: memory.bridge },
  });
  await expect(
    withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:patch-revoked", receiptAuthority: () => current },
      () =>
        tool.execute("sandbox-revoked", {
          input: "*** Begin Patch\n*** Update File: edit.txt\n@@\n-before\n+after\n*** End Patch",
        }),
    ),
  ).rejects.toThrow("authority is no longer active");
  expect(memory.files.get("/sandbox/edit.txt")).toBe("before\n");
});
