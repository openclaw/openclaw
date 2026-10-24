import { expect, it } from "vitest";
import {
  catalogJson,
  classProfile,
  commandResult,
} from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  OPERATION_ID,
  PROFILE as WARM_PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const PROFILE = { ...WARM_PROFILE, warmImage: false };

it.each([
  [undefined, "windows/wsl2", "windows --windows-mode wsl2"],
  [undefined, "windows/normal", "windows --windows-mode normal"],
  ["windows/normal", undefined, "windows --windows-mode normal"],
  [undefined, "macos", "macos --market on-demand"],
] as const)(
  "allocates the resolved OS (configured=%s, requested=%s)",
  async (configured, requested, targetArgs) => {
    const { provider, calls } = createWarmProvider();
    const profile = { ...PROFILE, ...(configured ? { target: configured } : {}) };
    const lease = await provisionWarmProfile(provider, profile, OPERATION_ID, undefined, {
      os: requested,
    });
    await provider.destroy({ ...lease, profile });
    const warmup = calls.find(({ argv }) => argv[1] === "warmup")!.argv;
    const targetIndex = warmup.indexOf("--target");
    expect(warmup.slice(targetIndex, targetIndex + 4)).toEqual([
      "--target",
      ...targetArgs.split(" "),
    ]);
    if (requested === "macos") {
      expect(warmup).not.toContain("--windows-mode");
    }
  },
);

it.each([
  {
    target: undefined,
    os: "windows/normal",
    setup: "node --version || exit 1",
    shell: "PowerShell",
  },
  { target: "windows/normal", os: "linux", setup: "& node.exe --version", shell: "POSIX" },
])(
  "rejects incompatible profile setup before allocation ($target -> $os)",
  async ({ target, os, setup, shell }) => {
    const { provider, calls } = createWarmProvider();
    await expect(
      provisionWarmProfile(
        provider,
        { ...PROFILE, provider: "azure", ...(target ? { target } : {}), setup },
        OPERATION_ID,
        undefined,
        {
          os,
          machineClass: "tiny",
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining(
        `select a profile with settings.target=${os} and a compatible ${shell} setup command`,
      ),
    });
    expect(calls).toEqual([]);
  },
);

it.each([
  { target: "windows/normal", os: "windows/normal", setup: "& node.exe --version" },
  { target: "linux", os: "windows/wsl2", setup: "node --version || exit 1" },
])("preserves compatible profile setup ($target -> $os)", async ({ target, os, setup }) => {
  const { provider, calls } = createWarmProvider();
  const profile = { ...PROFILE, target, setup };
  const lease = await provisionWarmProfile(provider, profile, OPERATION_ID, undefined, { os });
  expect(
    calls.filter(({ argv, options }) => argv[1] === "run" && options.input === setup),
  ).toHaveLength(1);
  await provider.destroy({ ...lease, profile });
});

it("keeps WSL2 cold with Linux warm images enabled", async () => {
  const target = "windows/wsl2";
  const { provider, calls } = createWarmProvider();
  for (const [profile, options] of [
    [{ ...PROFILE, warmImage: true, target }, undefined],
    [{ ...PROFILE, warmImage: true }, { os: target }],
  ] as const) {
    expect(provider.supportsProjectPreparation?.(profile, "standard", options?.os)).toBe(false);
  }
  expect(calls).toEqual([]);
});

it("explains the upstream WSL2 desktop limitation before allocating", async () => {
  const { provider, calls } = createWarmProvider();
  for (const [profile, options] of [
    [{ ...PROFILE, desktop: true, target: "windows/wsl2" }, undefined],
    [{ ...PROFILE, desktop: true }, { os: "windows/wsl2" }],
  ] as const) {
    await expect(
      provisionWarmProfile(provider, profile, OPERATION_ID, undefined, options),
    ).rejects.toThrow("select native Windows for a desktop viewer");
  }
  expect(calls).toEqual([]);
});

it("advertises only setup-compatible OS and machine choices without narrowing the shared catalog", async () => {
  const { provider } = createWarmProvider(({ argv }) =>
    argv[1] === "providers"
      ? commandResult({
          stdout: catalogJson(
            "azure",
            ["linux", "windows/wsl2", "windows/normal", "macos"],
            [
              classProfile("tiny"),
              classProfile("tiny", {}, { target: "windows", windowsMode: "wsl2" }),
              classProfile("tiny", {}, { target: "windows", windowsMode: "normal" }),
              classProfile("tiny", {}, { target: "macos" }),
            ],
          ),
        })
      : undefined,
  );
  const profile = { ...PROFILE, provider: "azure", class: "tiny" };
  for (const [settings, expected] of [
    [{ setup: "node --version || exit 1" }, ["linux", "windows/wsl2", "macos"]],
    [{ target: "windows/normal", setup: "& node.exe --version" }, ["windows/normal"]],
    [{}, ["linux", "windows/wsl2", "windows/normal", "macos"]],
  ] as const) {
    expect(
      (await provider.listOperatingSystems?.({ ...profile, ...settings }))?.map(({ id }) => id),
    ).toEqual(expected);
    expect(
      (await provider.listMachineOptions?.({ ...profile, ...settings }))?.map(({ os }) => os),
    ).toEqual(expected);
  }
});
