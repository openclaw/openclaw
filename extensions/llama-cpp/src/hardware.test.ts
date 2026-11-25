import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { detectLlamaCppHardware } from "./hardware.js";

const probes = vi.hoisted(() => ({
  output: "",
  error: undefined as Error | undefined,
  diskContainers: {} as Record<string, string>,
}));
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) =>
    callback(
      probes.error ?? null,
      file === "/bin/df"
        ? `/dev/${args[1] === "/models" ? "disk4s1" : "disk5s1"} 100 50 50 50% /volume`
        : file === "/usr/sbin/diskutil"
          ? (probes.diskContainers[args[2] ?? ""] ?? "")
          : probes.output,
      "",
    ),
}));

const GIB = 1024 ** 3;
const readStat = fs.stat;
const disk = {
  type: 0xef53,
  bsize: 4096,
  frsize: 4096,
  blocks: 100,
  bfree: 50,
  bavail: 40,
  files: 100,
  ffree: 50,
};
const detect = (options: Partial<Parameters<typeof detectLlamaCppHardware>[0]> = {}) =>
  detectLlamaCppHardware({ cacheDir: "/models", ...options });
async function useSeparateVolume() {
  const stat = await readStat(os.tmpdir());
  stat.dev += 1;
  vi.mocked(fs.stat).mockResolvedValueOnce(stat);
}

beforeEach(async () => {
  probes.output = "";
  probes.error = undefined;
  probes.diskContainers = {};
  vi.spyOn(os, "platform").mockReturnValue("linux");
  vi.spyOn(os, "arch").mockReturnValue("x64");
  vi.spyOn(os, "totalmem").mockReturnValue(32 * GIB);
  vi.spyOn(os, "freemem").mockReturnValue(4 * GIB);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(process, "availableMemory").mockReturnValue(4 * GIB);
  vi.spyOn(fs, "readFile").mockResolvedValue("MemAvailable:   16777216 kB\n");
  vi.spyOn(fs, "statfs").mockResolvedValue(disk);
  vi.spyOn(fs, "stat").mockResolvedValue(await fs.stat(os.tmpdir()));
});

afterEach(() => vi.restoreAllMocks());

it("uses the Gateway container budget instead of the physical host capacity", async () => {
  vi.spyOn(process, "constrainedMemory").mockReturnValue(8 * GIB);
  vi.spyOn(process, "availableMemory").mockReturnValue(3 * GIB);

  expect(await detect()).toMatchObject({
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 3 * GIB,
  });
});

it("reports reclaimable Linux memory and separate NVIDIA device budgets", async () => {
  probes.output =
    "NVIDIA Device A, 24576, 20000, 580.65.06, 8.9\nNVIDIA Device B, 8192, 4096, 580.65.06, 7.5";
  expect(await detect()).toMatchObject({
    totalMemoryBytes: 32 * GIB,
    availableMemoryBytes: 16 * GIB,
    availableDiskBytes: 40 * 4096,
    availableRuntimeDiskBytes: 40 * 4096,
    sharedDisk: true,
    accelerator: {
      kind: "cuda",
      devices: [
        {
          totalMemoryBytes: 24 * GIB,
          availableMemoryBytes: 20000 * 1024 ** 2,
          computeCapability: 8.9,
        },
        { totalMemoryBytes: 8 * GIB, availableMemoryBytes: 4 * GIB, computeCapability: 7.5 },
      ],
    },
  });
});

it("counts reclaimable Apple memory once and identifies unified Metal", async () => {
  vi.mocked(os.platform).mockReturnValue("darwin");
  vi.mocked(os.arch).mockReturnValue("arm64");
  probes.output =
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages inactive: 131072.\nPages purgeable: 32768.";
  const hardware = await detect();
  expect(hardware.availableMemoryBytes).toBe(3 * GIB);
  expect(hardware.accelerator).toEqual({ kind: "metal" });
});

it.each([
  ["separate ext4 volumes", 0xef53, 5, false],
  ["pooled Btrfs volumes", 0x9123683e, 40, true],
] as const)("accounts for %s", async (_name, type, runtimeFree, sharedDisk) => {
  await useSeparateVolume();
  vi.mocked(fs.statfs)
    .mockResolvedValueOnce({ ...disk, type })
    .mockResolvedValueOnce({ ...disk, type, bavail: runtimeFree });
  expect(await detect()).toMatchObject({
    availableDiskBytes: 40 * 4096,
    availableRuntimeDiskBytes: runtimeFree * 4096,
    sharedDisk,
  });
});

it.each([
  ["disk4", true],
  ["disk5", false],
  [undefined, true],
] as const)("accounts for APFS shared capacity: %s", async (runtimeContainer, sharedDisk) => {
  vi.mocked(os.platform).mockReturnValue("darwin");
  await useSeparateVolume();
  probes.diskContainers = {
    disk4s1: "<key>APFSContainerReference</key><string>disk4</string>",
    ...(runtimeContainer
      ? { disk5s1: `<key>APFSContainerReference</key><string>${runtimeContainer}</string>` }
      : {}),
  };

  expect((await detect()).sharedDisk).toBe(sharedDisk);
});

it.each([
  ["missing driver", "", new Error("ENOENT")],
  ["invalid telemetry", "NVIDIA Device, N/A, 4096, 580.65.06, 8.9", undefined],
] as const)("reports a CPU reason for %s", async (_name, output, error) => {
  Object.assign(probes, { output, error });
  expect((await detect()).accelerator).toMatchObject({ kind: "cpu", reason: expect.any(String) });
});

it("checks the nearest existing cache ancestor without creating directories", async () => {
  vi.mocked(fs.statfs).mockRejectedValueOnce(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
  const hardware = await detect({ cacheDir: "/models/new" });
  expect(hardware.availableDiskBytes).toBe(40 * 4096);
  expect(fs.statfs).toHaveBeenLastCalledWith("/models");
});

it("keeps unreadable disk capacity unknown", async () => {
  vi.mocked(fs.statfs).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));

  expect((await detect()).availableDiskBytes).toBeUndefined();
});

it("honors setup cancellation before probing", async () => {
  await expect(detect({ signal: AbortSignal.abort() })).rejects.toThrow();
  expect(fs.statfs).not.toHaveBeenCalled();
});
