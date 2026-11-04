import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const config: Record<string, unknown> = {};
  return { config, run: vi.fn() };
});
vi.mock("./crabbox-worker-command.js", () => ({
  runCrabboxCommand: async (params: unknown) => {
    state.run(params);
    return { stdout: JSON.stringify(state.config) };
  },
  crabboxCommandOutput: (_action: string, result: { stdout: string }) => result.stdout,
  parseCrabboxJson: (text: string) => JSON.parse(text),
}));
import {
  prepareCrabboxGuestIsolation,
  createCrabboxGuestCommandEnv,
} from "./crabbox-worker-preflight.js";
import { resolveCrabboxGuestProvisionProfile } from "./crabbox-worker-profile.js";

const current = vi.fn();
const check = () =>
  prepareCrabboxGuestIsolation({
    binary: "crabbox",
    provider: "aws",
    env: createCrabboxGuestCommandEnv({}),
    assertCurrent: current,
  });
beforeEach(() => {
  state.config = {
    provider: "aws",
    aws: { instanceProfile: "" },
    cache: { pnpm: false, npm: false, docker: false, git: false, volumes: null },
  };
  state.run.mockClear();
  current.mockReset();
});

describe("guest Crabbox control-plane isolation", () => {
  it("keeps provider credentials on the CLI while disabling implicit forwarding and shared caches", async () => {
    const env = createCrabboxGuestCommandEnv({
      AWS_SECRET_ACCESS_KEY: "CONTROL_PLANE_CANARY",
      CRABBOX_ENV_ALLOW: "AWS_SECRET_ACCESS_KEY",
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("CONTROL_PLANE_CANARY");
    expect(env.CRABBOX_ENV_ALLOW).toBe(",");
    expect(env.CRABBOX_CACHE_VOLUMES).toBe(",");
    expect(env.CRABBOX_CACHE_GIT).toBe("false");
    await check();
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["config", "show", "--json", "--provider", "aws"] }),
    );
    expect(current).toHaveBeenCalledOnce();
  });
  it.each([
    { provider: "gcp", aws: { instanceProfile: "" } },
    { provider: "aws", aws: { instanceProfile: "privileged-role" } },
    { provider: "aws", aws: {} },
    {
      provider: "aws",
      aws: { instanceProfile: "" },
      cache: { pnpm: true, npm: false, docker: false, git: false, volumes: [] },
    },
    {
      provider: "aws",
      aws: { instanceProfile: "" },
      cache: {
        pnpm: false,
        npm: false,
        docker: false,
        git: false,
        volumes: [{ hostPath: "/host" }],
      },
    },
  ])("rejects substituted identity or shared-state configuration %#", async (override) => {
    state.config = { ...state.config, ...override };
    await expect(check()).rejects.toThrow();
  });
  it("refuses an unqualified provider without touching its control plane", async () => {
    await expect(
      prepareCrabboxGuestIsolation({
        binary: "crabbox",
        provider: "local",
        env: {},
        assertCurrent: current,
      }),
    ).rejects.toThrow("not qualified");
    expect(state.run).not.toHaveBeenCalled();
  });
  it("rechecks authority after configuration inspection", async () => {
    current.mockImplementation(() => {
      throw new Error("guest revoked");
    });
    await expect(check()).rejects.toThrow("guest revoked");
  });
  it("preserves typed class and OS selection but drops operator setup and mutable images", () => {
    const { profile } = resolveCrabboxGuestProvisionProfile(
      {
        provider: "aws",
        class: "small",
        ttl: "60m",
        idleTimeout: "30m",
        setup: "MODEL_AUTH_CANARY",
        warmImage: true,
      },
      "c7i.xlarge",
      "linux",
    );
    expect(profile.class).toBe("c7i.xlarge");
    expect(profile.target).toBe("linux");
    expect(profile.setup).toBeUndefined();
    expect(profile.setupSecrets).toBeUndefined();
    expect(profile.warmImage).toBe(false);
  });
});
