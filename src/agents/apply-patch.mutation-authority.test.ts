import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createApplyPatchTool } from "./apply-patch.js";
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
