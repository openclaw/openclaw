import { expect, it } from "vitest";
import {
  buildCrabboxAllocationArgs,
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
  resolveCrabboxPreparationTarget,
  resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";

it("explicitly requests Linux when the profile uses the default target", () => {
  const profile = parseCrabboxProfile({ provider: "aws", ttl: "24h", idleTimeout: "60m" });
  expect(buildCrabboxAllocationArgs(profile, "cbx_linux", "linux-worker")).toEqual([
    "--provider",
    "aws",
    "--network",
    "public",
    "--tailscale=false",
    "--target",
    "linux",
    "--ttl",
    "24h",
    "--idle-timeout",
    "60m",
    "--lease-id",
    "cbx_linux",
    "--slug",
    "linux-worker",
    "--keep=true",
  ]);
});

it("keys snapshots by resolved disk inputs while ignoring allocation policy", () => {
  const profile = parseCrabboxProfile({
    provider: "AWS",
    class: "standard",
    ttl: "24h",
    idleTimeout: "60m",
    setup: "install-tools",
    setupSecrets: {
      SECOND: { source: "store", provider: "default", id: "SECOND" },
      FIRST: { source: "store", provider: "default", id: "FIRST" },
    },
  });
  const key = resolveCrabboxWarmImageProfileKey(profile, "project-a");
  // Retired plaintext setup images must never be adopted as protected-egress images.
  expect(key).not.toBe("94d5e2bed9c520eb30e92546173acae225ba557b9af4795ec1f95afa0d3fe178");
  expect(
    resolveCrabboxWarmImageProfileKey(
      {
        ...profile,
        ttl: "48h",
        idleTimeout: "120m",
        idleTimeoutMs: 7_200_000,
        heartbeatIntervalMs: 1234,
        heartbeatTimeoutMs: 5678,
        binary: "/other/crabbox",
        warmImage: true,
        desktop: false,
        setupSecrets: {
          FIRST: { source: "store", provider: "default", id: "FIRST" },
          SECOND: { source: "store", provider: "default", id: "SECOND" },
        },
      },
      "project-a",
    ),
  ).toBe(key);
  for (const changed of [
    { ...profile, provider: "hetzner" },
    { ...profile, class: "fast" },
    { ...profile, setup: "install-other-tools" },
    {
      ...profile,
      setupSecrets: { OTHER: { source: "store" as const, provider: "default", id: "OTHER" } },
    },
    {
      ...profile,
      setupSecrets: { FIRST: { source: "store" as const, provider: "other", id: "FIRST" } },
    },
    { ...profile, desktop: true },
    { ...profile, target: "macos" as const },
  ]) {
    expect(resolveCrabboxWarmImageProfileKey(changed, "project-a")).not.toBe(key);
  }
  expect(resolveCrabboxWarmImageProfileKey(profile, "project-b")).not.toBe(key);
});

const PROFILE = { provider: "aws", class: "standard", ttl: "24h", idleTimeout: "60m" };

it("pins the Linux warm-image profile key without setup secrets", () => {
  const profile = parseCrabboxProfile({
    ...PROFILE,
    class: "tiny",
    target: "linux",
    warmImage: true,
    desktop: false,
  });
  // Changing this value invalidates every user's warm images on update; change deliberately and explain why in the PR.
  expect(resolveCrabboxWarmImageProfileKey(profile)).toBe(
    "6b01b9af04cfd3441ea20fde45d9951b39cf4c2da9a5df3c62dd8a1929725254",
  );
});

it("accepts bounded store references for recipe setup without a profile setup command", () => {
  const setupSecrets = { npm_token: { source: "store", provider: "default", id: "NPM_TOKEN" } };
  expect(parseCrabboxProfile({ ...PROFILE, setupSecrets }).setupSecrets).toEqual(setupSecrets);
  expect(resolveCrabboxProvisionProfile({ ...PROFILE, setupSecrets }, undefined)).toMatchObject({
    profile: { warmImage: true, setupSecrets },
  });
  expect(resolveCrabboxPreparationTarget({ ...PROFILE, setupSecrets })).toMatchObject({
    machineClass: "standard",
    platform: "linux",
  });
  expect(
    resolveCrabboxPreparationTarget({ ...PROFILE, warmImage: false, setupSecrets }),
  ).toMatchObject({
    machineClass: "standard",
    platform: "linux",
  });
  expect(resolveCrabboxPreparationTarget({ ...PROFILE, warmImage: false })).toBeUndefined();
  expect(
    resolveCrabboxPreparationTarget({ ...PROFILE, target: "macos", setupSecrets }),
  ).toBeUndefined();
});

it.each([
  [{ TOKEN: "literal" }, "store SecretRef"],
  [{ TOKEN: { source: "env", provider: "default", id: "TOKEN" } }, "store SecretRef"],
  [
    { TOKEN: { source: "store", provider: "default", id: "TOKEN", extra: true } },
    "store SecretRef",
  ],
  [{ TOKEN: { source: "store", provider: "BAD ALIAS", id: "TOKEN" } }, "store SecretRef"],
  [{ TOKEN: { source: "store", provider: "default", id: "bad-name" } }, "store SecretRef"],
  [{ "BAD-NAME": { source: "store", provider: "default", id: "TOKEN" } }, "POSIX"],
  [{ HTTPS_PROXY: { source: "store", provider: "default", id: "TOKEN" } }, "reserved"],
  [{ OPENCLAW_WORKTREE_PATH: { source: "store", provider: "default", id: "TOKEN" } }, "reserved"],
  [[], "map"],
  [
    Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `TOKEN_${index}`,
        { source: "store", provider: "default", id: "TOKEN" },
      ]),
    ),
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
