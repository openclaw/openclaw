import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveGatewayServiceCgroupDirectory } from "../../process/linux-exec-cgroup.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
import {
  writeFakeContainerExecutable,
  writeFakeSystemdScope,
} from "./container-engine.scope.test-support.js";

vi.mock("../../process/linux-exec-cgroup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/linux-exec-cgroup.js")>()),
  resolveGatewayServiceCgroupDirectory: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32").for([
  {
    name: "bound local Podman",
    engine: { ...PODMAN_SANDBOX_ENGINE, globalArgs: [] },
    scoped: true,
  },
  {
    name: "captured local Podman",
    engine: { ...PODMAN_SANDBOX_ENGINE, globalArgs: [] },
    scoped: true,
    captured: true,
  },
  { name: "Podman discovery", engine: PODMAN_SANDBOX_ENGINE, scoped: false },
  {
    name: "remote Podman",
    engine: { ...PODMAN_SANDBOX_ENGINE, globalArgs: ["--url", "unix:///synthetic/podman.sock"] },
    scoped: false,
  },
  { name: "Docker", engine: DOCKER_SANDBOX_ENGINE, scoped: false },
  {
    name: "undelegated Podman",
    engine: { ...PODMAN_SANDBOX_ENGINE, globalArgs: [] },
    scoped: false,
    delegated: false,
  },
  {
    name: "rootful Podman",
    engine: { ...PODMAN_SANDBOX_ENGINE, globalArgs: [] },
    scoped: false,
    uid: 0,
  },
  {
    name: "non-Linux Podman",
    engine: { ...PODMAN_SANDBOX_ENGINE, globalArgs: [] },
    scoped: false,
    platform: "darwin",
  },
] as const)("preserves process I/O and arguments for $name", async (entry, { signal }) => {
  mockProcessPlatform(("platform" in entry ? entry.platform : undefined) ?? "linux");
  vi.spyOn(process, "getuid").mockReturnValue(("uid" in entry ? entry.uid : undefined) ?? 1000);
  vi.mocked(resolveGatewayServiceCgroupDirectory).mockReturnValue(
    "delegated" in entry ? undefined : "/sys/fs/cgroup/system.slice/openclaw.service",
  );
  const directory = tempDirs.make("openclaw-container-scope-");
  writeFakeSystemdScope(directory);
  writeFakeContainerExecutable(
    directory,
    entry.engine.command,
    `
const input = require("node:fs").readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, scoped: process.env.OPENCLAW_TEST_USER_SCOPE === "true", invocation: process.env.INVOCATION_ID, userBus: process.env.DBUS_SESSION_BUS_ADDRESS }));
process.stderr.write("engine-stderr");
process.exitCode = 7;
`,
  );
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("INVOCATION_ID", "gateway-invocation");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
  vi.stubEnv("OPENCLAW_TEST_USER_SCOPE", undefined);
  const baseEnv = "captured" in entry ? { ...process.env } : undefined;
  const args = ["exec", "$HOME", "space 'quotes' ${HOME}"];
  const result = await execContainerRaw({ ...entry.engine, baseEnv }, args, {
    input: "input\u0000bytes",
    allowFailure: true,
    signal,
  });
  expect(result.code).toBe(7);
  expect(result.stderr.toString()).toBe("engine-stderr");
  expect(JSON.parse(result.stdout.toString())).toEqual({
    args: [...(entry.engine.globalArgs ?? []), ...args],
    input: "input\u0000bytes",
    scoped: entry.scoped,
    invocation: "gateway-invocation",
    userBus: "unix:path=/run/user/1000/bus",
  });
  expect(process.env.INVOCATION_ID).toBe("gateway-invocation");
  expect(baseEnv?.OPENCLAW_TEST_USER_SCOPE).toBeUndefined();
});
