import { describe, expect, it } from "vitest";
import {
  readCrabboxRuntimeInstallation,
  type CrabboxRuntimeInstallationIdentity,
} from "../cli-runtime-api.js";

const expected: CrabboxRuntimeInstallationIdentity = {
  nodeBootstrap: {
    sha256: "a".repeat(64),
    bytes: 123,
    manifestSha256: "b".repeat(64),
    buildId: "fixture-build",
    openclawVersion: "2026.8.1",
    enabledPluginIds: ["fixture"],
  },
  workerBundle: {
    sha256: "c".repeat(64),
    bytes: 456,
    packageRelativePath: `worker-artifacts/${"c".repeat(64)}.tgz`,
  },
};
const receipt = {
  schema: "openclaw.runtime-installation.v1",
  installationVerified: true,
  disposition: "installed",
  ...expected,
};
const line = (value: unknown) => `openclaw.runtime-installed:${JSON.stringify(value)}`;

describe("native runtime installation receipts", () => {
  it.each(["installed", "existing-verified"])(
    "reads one %s result beside ordinary command output",
    (disposition) => {
      const result = { ...receipt, disposition };
      expect(readCrabboxRuntimeInstallation(`setup output\n${line(result)}\n`, expected)).toEqual(
        result,
      );
    },
  );

  it.each([
    ["missing", "setup output"],
    ["duplicate", `${line(receipt)}\n${line(receipt)}`],
    ["unbounded UTF-8", line({ ...receipt, extra: "🦞".repeat(4096) })],
    ["unverified", line({ ...receipt, installationVerified: false })],
    [
      "different build",
      line({ ...receipt, nodeBootstrap: { ...expected.nodeBootstrap, buildId: "other" } }),
    ],
    [
      "different worker",
      line({ ...receipt, workerBundle: { ...expected.workerBundle, bytes: 999 } }),
    ],
  ])("rejects %s receipts", (_name, output) => {
    expect(() => readCrabboxRuntimeInstallation(output, expected)).toThrow();
  });
});
