import { expect, it } from "vitest";
import {
  buildCrabboxAllocationArgs,
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
  resolveCrabboxPreparationTarget,
  resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";

const PROFILE = { provider: "aws", class: "standard", ttl: "24h", idleTimeout: "60m" };
const storeRef = (id = "TOKEN", provider = "default") => ({
  source: "store" as const,
  provider,
  id,
});

it("explicitly requests Linux when the profile uses the default target", () => {
  const profile = parseCrabboxProfile({ provider: "aws", ttl: "24h", idleTimeout: "60m" });
  expect(buildCrabboxAllocationArgs(profile, "cbx_linux", "linux-worker")).toEqual(
    (
      "--provider aws --network public --tailscale=false --target linux --ttl 24h " +
      "--idle-timeout 60m --lease-id cbx_linux --slug linux-worker --keep=true"
    ).split(" "),
  );
});

it("keys snapshots by resolved disk inputs while ignoring allocation policy", () => {
  const profile = parseCrabboxProfile({
    ...PROFILE,
    provider: "AWS",
    setup: "install-tools",
    setupSecrets: {
      SECOND: storeRef("SECOND"),
      FIRST: storeRef("FIRST"),
    },
  });
  const key = resolveCrabboxWarmImageProfileKey(profile, "project-a");
  // Retired plaintext setup images must never be adopted as protected-egress images.
  expect(key).not.toBe("94d5e2bed9c520eb30e92546173acae225ba557b9af4795ec1f95afa0d3fe178");
  const keyFor = (overrides: Partial<typeof profile>) =>
    resolveCrabboxWarmImageProfileKey({ ...profile, ...overrides }, "project-a");
  expect(
    keyFor({
      ttl: "48h",
      idleTimeout: "120m",
      idleTimeoutMs: 7_200_000,
      heartbeatIntervalMs: 1234,
      heartbeatTimeoutMs: 5678,
      binary: "/other/crabbox",
      warmImage: true,
      desktop: false,
      setupSecrets: {
        FIRST: storeRef("FIRST"),
        SECOND: storeRef("SECOND"),
      },
    }),
  ).toBe(key);
  const changedProfiles: Partial<typeof profile>[] = [
    { provider: "hetzner" },
    { class: "fast" },
    { setup: "install-other-tools" },
    { setupSecrets: { OTHER: storeRef("OTHER") } },
    { setupSecrets: { FIRST: storeRef("FIRST", "other") } },
    { desktop: true },
    { target: "macos" as const },
  ];
  for (const changed of changedProfiles) {
    expect(keyFor(changed)).not.toBe(key);
  }
  expect(resolveCrabboxWarmImageProfileKey(profile, "project-b")).not.toBe(key);
});

it("pins the Linux warm-image profile key without setup secrets", () => {
  const profile = parseCrabboxProfile({ ...PROFILE, class: "tiny" });
  // Changing this value invalidates every user's warm images on update; change deliberately and explain why in the PR.
  expect(resolveCrabboxWarmImageProfileKey(profile)).toBe(
    "6b01b9af04cfd3441ea20fde45d9951b39cf4c2da9a5df3c62dd8a1929725254",
  );
});

it("accepts bounded store references for recipe setup without a profile setup command", () => {
  const setupSecrets = { npm_token: storeRef("NPM_TOKEN") };
  const recipe = { ...PROFILE, setupSecrets };
  const target = { machineClass: "standard", platform: "linux" };
  expect(parseCrabboxProfile(recipe).setupSecrets).toEqual(setupSecrets);
  expect(resolveCrabboxProvisionProfile(recipe, undefined)).toMatchObject({
    profile: { warmImage: true, setupSecrets },
  });
  expect(resolveCrabboxPreparationTarget(recipe)).toMatchObject(target);
  expect(resolveCrabboxPreparationTarget({ ...recipe, warmImage: false })).toMatchObject(target);
  expect(resolveCrabboxPreparationTarget({ ...PROFILE, warmImage: false })).toBeUndefined();
  expect(resolveCrabboxPreparationTarget({ ...recipe, target: "macos" })).toBeUndefined();
});

it.each([
  [{ TOKEN: "literal" }, "store SecretRef"],
  [{ TOKEN: { ...storeRef(), source: "env" } }, "store SecretRef"],
  [{ TOKEN: { ...storeRef(), extra: true } }, "store SecretRef"],
  [{ TOKEN: storeRef("TOKEN", "BAD ALIAS") }, "store SecretRef"],
  [{ TOKEN: storeRef("bad-name") }, "store SecretRef"],
  [{ "BAD-NAME": storeRef() }, "POSIX"],
  [{ HTTPS_PROXY: storeRef() }, "reserved"],
  [{ OPENCLAW_WORKTREE_PATH: storeRef() }, "reserved"],
  [[], "map"],
  [
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`TOKEN_${index}`, storeRef()])),
    "at most 16",
  ],
])("rejects unsafe setupSecrets %j", (setupSecrets, message) => {
  expect(() => parseCrabboxProfile({ ...PROFILE, setupSecrets })).toThrow(message);
});

it.each([{ setupEnv: [] }, { setupEnv: ["TOKEN"] }, { setupEnv: "TOKEN" }])(
  "refuses retired setupEnv $setupEnv before provisioning",
  ({ setupEnv }) => {
    expect(() => resolveCrabboxProvisionProfile({ ...PROFILE, setupEnv }, undefined)).toThrow(
      "run openclaw doctor --fix",
    );
  },
);
