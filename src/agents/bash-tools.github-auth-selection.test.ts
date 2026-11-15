import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { resolveManagedGitHubProfileDir } from "./github-tool-identity.js";

const relayCapture = vi.hoisted(() => ({
  sends: [] as MockInstance<ChildProcess["send"]>[],
}));
afterEach(async () => {
  for (const send of relayCapture.sends.splice(0)) {
    send.mockRestore();
  }
  vi.unstubAllEnvs();
  await state?.cleanup();
  state = undefined;
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (child.connected) {
        relayCapture.sends.push(vi.spyOn(child, "send"));
      }
      return child;
    },
  };
});

// Synthetic credential probe: missing/foreign tokens report the native-account sentinel.
const authContractFixture = String.raw`
const fs = require("node:fs");
const suppliedProfile = process.argv[2];
if (!suppliedProfile || process.env.GH_CONFIG_DIR !== suppliedProfile) {
  throw new Error("Fixture requires the explicitly supplied synthetic profile");
}
if (process.argv[3] === "deleted-after-launch") fs.rmSync(suppliedProfile, { recursive: true });
const source = ["GH_TOKEN", "GITHUB_TOKEN"].find((name) => process.env[name]);
const accounts = new Map([["managed-token", "managed"]]);
const account = accounts.get(source && process.env[source]) ?? "synthetic-native-account";
const lineage = process.argv[4] === "service"
  ? { lineage: fs.fstatSync(3).isSocket() || fs.fstatSync(3).isFIFO() } : {};
process.stdout.write(JSON.stringify({ account, source, ...lineage }) + "\n");
`;

let state: OpenClawTestState | undefined;
let profileDir: string;
let fixturePath: string;
const profileId = "ghp_11111111111111111111111111111111";
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "github-auth-repro-" });
  const home = state.home;
  for (const [key, value] of Object.entries({
    ZDOTDIR: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GH_CONFIG_DIR: undefined,
    GH_TOKEN: "ambient-gh-token",
    GITHUB_TOKEN: "ambient-github-token",
  })) {
    vi.stubEnv(key, value);
  }
  profileDir = resolveManagedGitHubProfileDir({ agentId: "main", scope: "system", profileId });
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(profileDir, "hosts.yml"),
    JSON.stringify({ "github.com": { oauth_token: "managed-token" } }),
    { mode: 0o600 },
  );
  fixturePath = state.path("auth-contract-fixture.cjs");
  await fs.writeFile(fixturePath, authContractFixture, { mode: 0o600 });
});

function command(...args: string[]) {
  return [process.execPath, fixturePath, profileDir, ...args].map(quoteCliArg).join(" ");
}

describe.skipIf(process.platform === "win32")("selected GitHub profile authentication", () => {
  it.each([
    { pty: true, service: false },
    { pty: false, service: true },
  ])("deleted profile binds local auth (pty=$pty, service=$service)", async ({ pty, service }) => {
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", service ? "synthetic-github-exec-proof" : undefined);
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
      notifyOnExit: false,
      cwd: state?.root,
      config: { tools: { github: { profileId } } },
      agentId: "main",
    });
    const result = await tool.execute("synthetic-auth", {
      command: command("deleted-after-launch", service ? "service" : "direct"),
      pty,
    });
    const output = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (service) {
      const requests = relayCapture.sends.flatMap((send) =>
        send.mock.calls.map(([message]) => message),
      );
      expect(requests).not.toHaveLength(0);
      const serialized = JSON.stringify(requests);
      for (const token of ["managed-token", "ambient-gh-token", "ambient-github-token"]) {
        expect(serialized).not.toContain(token);
      }
    }
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.parse(output)).toEqual({
      account: "managed",
      source: "GH_TOKEN",
      ...(service ? { lineage: true } : {}),
    });
  });
});
