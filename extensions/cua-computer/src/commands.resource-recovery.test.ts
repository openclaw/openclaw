import fs from "node:fs/promises";
import path from "node:path";
import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestProvider, driver, result } from "./commands.test-helpers.js";
import { CUA_DRIVER_CONTRACT_FIXTURES as fixtures } from "./cua-driver-contract.test-fixtures.js";
import { createCuaDriver } from "./driver-client.js";

const temporaryRoot = vi.hoisted(() => ({ path: "" }));
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-access-runtime")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () =>
      temporaryRoot.path || actual.resolvePreferredOpenClawTmpDir(),
  };
});

it.each(["retry", "close"])(
  "recovers %s after recording resource initialization fails",
  async (next) => {
    const directory = useAutoCleanupTempDirTracker(onTestFinished).make("cua-recovery-");
    temporaryRoot.path = path.join(directory, "resources");
    onTestFinished(() => {
      temporaryRoot.path = "";
    });
    await fs.writeFile(temporaryRoot.path, "not a directory");
    const native = driver();
    native.callTool.mockImplementation(async (name, args) =>
      result(
        name === "start_recording"
          ? { ...fixtures.recordingActive, output_dir: args.output_dir }
          : fixtures.recordingStopped,
      ),
    );
    const commands: OpenClawPluginNodeHostCommand[] = [];
    registerComputerUseProvider(
      { registerNodeHostCommand: (command) => commands.push(command) },
      createTestProvider(native.session),
    );
    const command = commands.find((entry) => entry.command === "computer.act")!;
    let executionId = "123e4567-e89b-42d3-a456-426614174000";
    const act = (action: string) => command.handle(JSON.stringify({ executionId, action }));
    onTestFinished(async () => {
      // The broken base cannot close; still release this fixture's native driver.
      await act("__close_execution").catch(() => {});
      await native.session.dispose();
    });
    await expect(act("start_recording")).rejects.toThrow("root dir is not a directory");
    expect(native.callTool).not.toHaveBeenCalled();
    await fs.unlink(temporaryRoot.path);
    await fs.mkdir(temporaryRoot.path);

    if (next === "retry") {
      await expect(act("start_recording")).resolves.toContain('"recording":true');
      expect(native.callTool).toHaveBeenCalledOnce();
    }
    await expect(act("__close_execution")).resolves.toBe('{"ok":true}');
    expect(native.dispose).toHaveBeenCalledOnce();
    const replacement = driver();
    vi.mocked(createCuaDriver).mockReturnValueOnce(replacement.session);
    executionId = "123e4567-e89b-42d3-a456-426614174001";
    await expect(act("get_recording_state")).resolves.toContain('"recording":false');
    await act("__close_execution");
    expect(replacement.dispose).toHaveBeenCalledOnce();
  },
);
