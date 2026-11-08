import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { expect, it, onTestFinished, vi } from "vitest";
import { driver, execution, result } from "./commands.test-helpers.js";
import { CUA_DRIVER_CONTRACT_FIXTURES as fixtures } from "./cua-driver-contract.test-fixtures.js";

const temporaryRoot = vi.hoisted(() => ({ path: "" }));
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-access-runtime")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () =>
      temporaryRoot.path || actual.resolvePreferredOpenClawTmpDir(),
  };
});

it.each(["retry", "close"])("recovers %s after resource initialization fails", async (next) => {
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
  const computer = await execution(native.session);
  onTestFinished(async () => {
    // The broken baseline cannot close; still release the fixture's driver.
    await computer.close("cancel").catch(() => {});
    await native.session.dispose();
  });
  await expect(computer.act('{"action":"start_recording"}')).rejects.toThrow(
    "root dir is not a directory",
  );
  expect(native.callTool).not.toHaveBeenCalled();
  await fs.unlink(temporaryRoot.path);
  await fs.mkdir(temporaryRoot.path);

  if (next === "retry") {
    await expect(computer.act('{"action":"start_recording"}')).resolves.toContain(
      '"recording":true',
    );
    expect(native.callTool).toHaveBeenCalledOnce();
  }
  await expect(computer.close("cancel")).resolves.toBeUndefined();
  expect(native.dispose).toHaveBeenCalledOnce();
});
