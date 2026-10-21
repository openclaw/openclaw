import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { resolveManagedGitHubProfileDir } from "./github-tool-identity.js";

const relayCapture = vi.hoisted(() => ({
  sends: undefined as MockInstance<ChildProcess["send"]>[] | undefined,
}));
afterEach(async () => {
  const sends = relayCapture.sends;
  relayCapture.sends = undefined;
  for (const send of sends ?? []) {
    send.mockRestore();
  }
  vi.unstubAllEnvs();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
  root = undefined;
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (child.connected && relayCapture.sends) {
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
const accounts = new Map([["managed-token", "managed"], ["rotated-token", "rotated"]]);
const account = accounts.get(source && process.env[source]) ?? "synthetic-native-account";
const lineage = process.argv[4] === "service"
  ? { lineage: fs.fstatSync(3).isSocket() || fs.fstatSync(3).isFIFO() } : {};
process.stdout.write(JSON.stringify({ account, source, ...lineage }) + "\n");
`;

let root: string | undefined;
let profileDir: string;
let fixturePath: string;
const profileId = "ghp_11111111111111111111111111111111";
beforeEach(async () => {
  const artifacts = path.join(process.cwd(), ".artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  root = await fs.realpath(await fs.mkdtemp(path.join(artifacts, "github-auth-repro-")));
  const home = path.join(root, "home");
  const state = path.join(home, ".openclaw");
  await fs.mkdir(home, { mode: 0o700 });
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    ZDOTDIR: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
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
  fixturePath = path.join(root, "auth-contract-fixture.cjs");
  await fs.writeFile(fixturePath, authContractFixture, { mode: 0o600 });
});

function command(...args: string[]) {
  return [process.execPath, fixturePath, profileDir, ...args].map(quoteCliArg).join(" ");
}

async function writeProfile(token?: string) {
  await fs.writeFile(
    path.join(profileDir, "hosts.yml"),
    JSON.stringify({ "github.com": { oauth_token: token } }),
    { mode: 0o600 },
  );
}

describe.skipIf(process.platform === "win32")("selected GitHub profile authentication", () => {
  it.each([
    { pty: false, service: false, profileState: "tokenless" },
    { pty: false, service: false, profileState: "available" },
    { pty: true, service: false, profileState: "deleted-after-launch" },
    { pty: false, service: true, profileState: "deleted-after-launch" },
  ])(
    "$profileState profile binds local auth (pty=$pty, service=$service)",
    async ({ profileState, pty, service }) => {
      const sends: MockInstance<ChildProcess["send"]>[] = [];
      relayCapture.sends = sends;
      vi.stubEnv("OPENCLAW_SERVICE_MARKER", service ? "synthetic-github-exec-proof" : undefined);
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
        notifyOnExit: false,
        cwd: root,
        config: { tools: { github: { profileId } } },
        agentId: "main",
      });
      await writeProfile(profileState === "tokenless" ? undefined : "managed-token");
      const result = await tool.execute(`synthetic-auth-${profileState}`, {
        command: command(profileState, service ? "service" : "direct"),
        pty,
      });
      const output = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (service) {
        const requests = sends.flatMap((send) => send.mock.calls.map(([message]) => message));
        expect(requests).toContainEqual(
          expect.objectContaining({
            type: "prepare",
            env: expect.objectContaining({ GH_TOKEN: "", GITHUB_TOKEN: "" }),
          }),
        );
        const serialized = JSON.stringify(requests);
        for (const token of ["managed-token", "ambient-gh-token", "ambient-github-token"]) {
          expect(serialized).not.toContain(token);
        }
      }
      if (profileState === "tokenless") {
        expect(result.details).toMatchObject({ exitCode: 1 });
        expect(output).toContain("Reconnect or change GitHub Identity");
        expect(output).not.toContain("synthetic-native-account");
        return;
      }
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(JSON.parse(output)).toEqual({
        account: "managed",
        source: "GH_TOKEN",
        ...(service ? { lineage: true } : {}),
      });
      if (profileState === "available") {
        await writeProfile("rotated-token");
        const refreshed = await tool.execute("refreshed-auth", { command: command(), pty });
        expect(refreshed.content).toEqual([
          {
            type: "text",
            text: JSON.stringify({ account: "rotated", source: "GH_TOKEN" }),
          },
        ]);
      }
    },
  );
});
