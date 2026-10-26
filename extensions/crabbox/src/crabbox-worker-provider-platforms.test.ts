import { expect, it } from "vitest";
import {
  catalogJson,
  classProfile,
  commandResult,
} from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  PROFILE as WARM_PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const PROFILE = { ...WARM_PROFILE, warmImage: false };
type Profile = NonNullable<Parameters<typeof provisionWarmProfile>[1]>;
function scenario() {
  const fixture = createWarmProvider();
  return {
    ...fixture,
    provision: (profile: Profile, os?: string) =>
      provisionWarmProfile(fixture.provider, profile, undefined, undefined, { os }),
  };
}

it.each([
  ["linux", "windows/wsl2", "windows --windows-mode wsl2", "node --version || exit 1"],
  ["windows/normal", "windows/normal", "windows --windows-mode normal", "& node.exe --version"],
  ["windows/normal", undefined, "windows --windows-mode normal", undefined],
  [undefined, "macos", "macos --market on-demand", undefined],
] as const)(
  "allocates the resolved OS and runs compatible setup (configured=%s, requested=%s)",
  async (configured, requested, targetArgs, setup) => {
    const { provider, calls, provision } = scenario();
    const profile = {
      ...PROFILE,
      ...(configured ? { target: configured } : {}),
      ...(setup ? { setup } : {}),
    };
    const lease = await provision(profile, requested);
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
    if (setup) {
      expect(
        calls.filter(({ argv, options }) => argv[1] === "run" && options.input === setup),
      ).toHaveLength(1);
    }
  },
);

it.each([
  [
    { setup: "node --version || exit 1" },
    "windows/normal",
    "select a profile with settings.target=windows/normal and a compatible PowerShell setup command",
  ],
  [
    { target: "windows/normal", setup: "& node.exe --version" },
    "linux",
    "select a profile with settings.target=linux and a compatible POSIX setup command",
  ],
  [
    { desktop: true, target: "windows/wsl2" },
    undefined,
    "select native Windows for a desktop viewer",
  ],
  [{ desktop: true }, "windows/wsl2", "select native Windows for a desktop viewer"],
] satisfies [Partial<Profile>, string | undefined, string][])(
  "rejects incompatible profile before allocation (%j -> %s)",
  async (settings, os, message) => {
    const { calls, provision } = scenario();
    await expect(
      provision({ ...PROFILE, provider: "azure", ...settings }, os),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining(message),
    });
    expect(calls).toEqual([]);
  },
);

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
