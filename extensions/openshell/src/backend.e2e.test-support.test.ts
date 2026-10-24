import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parse } from "yaml";
import {
  buildOpenShellPolicyYaml,
  cleanupOpenShellWorkspace,
  runCommand,
} from "./backend.e2e.test-support.js";

it.each<[string, string[]]>([
  ["  ", ["10.0.0.0/8", "172.0.0.0/8", "192.168.0.0/16", "fc00::/7"]],
  [" 198.51.100.42 ", ["198.51.100.42/32"]],
])("host policy preserves IP override %j, endpoint and binary", (hostIp, allowedIps) => {
  const yaml = buildOpenShellPolicyYaml({ port: 17680, binaryPath: "/usr/bin/curl", hostIp });
  const hostEcho = {
    endpoints: [
      {
        host: "host.openshell.internal",
        port: 17680,
        protocol: "rest",
        enforcement: "enforce",
        access: "full",
        allowed_ips: allowedIps,
      },
    ],
    binaries: [{ path: "/usr/bin/curl" }],
  };
  expect(parse(yaml)).toMatchObject({ network_policies: { host_echo: hostEcho } });
});

it.runIf(process.platform !== "win32")("reports a signal-killed probe as failure", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    allowFailure: true,
    timeoutMs: 10_000,
  });
  expect(result.code).not.toBe(0);
});

afterEach(() => vi.restoreAllMocks());

async function createCleanupFixture(options: { mode?: string; inventory?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openshell-cleanup-test-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state.json");
  const command = path.join(root, "openshell");
  const initial = {
    names: ["first", "second"],
    listCalls: 0,
    deletes: [] as string[],
    workspaceDeletes: 0,
    ...options,
  };
  await fs.writeFile(stateFile, JSON.stringify(initial));
  await fs.writeFile(
    command,
    `#!${process.execPath}
const fs = require("node:fs");
const stateFile = process.env.FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
let failure;
if (args[0] === "workspace") {
  state.workspaceDeletes++;
  if (state.names.length) failure = "workspace still contains durable sandbox records";
  if (state.mode === "workspace-failure") failure = "workspace cleanup failed";
} else if (args[3] === "delete") {
  state.pending = args[4];
  state.deletes.push(state.pending);
  state.observations = 0;
  if (state.mode === "delete-failure" && state.pending === "first") failure = "delete failed";
} else if (args[3] === "list") {
  state.listCalls++;
  if (state.pending && ++state.observations >= 2 && state.mode !== "stuck") {
    state.names = state.names.filter(name => name !== state.pending);
    state.pending = "";
  }
  if (state.mode === "read-failure" && state.deletes.length) failure = "database is locked";
  const limit = Number(args[args.indexOf("--limit") + 1]);
  console.log(state.inventory ?? JSON.stringify(state.names.slice(0, limit).map(name => ({ name }))));
} else {
  throw new Error("unexpected fixture command");
}
fs.writeFileSync(stateFile, JSON.stringify(state));
if (failure) throw new Error(failure);
if (state.mode === "stuck" && state.observations > 0) {
  fs.writeFileSync(stateFile + ".expired", "");
}
`,
    { mode: 0o755 },
  );
  return {
    cleanup: () =>
      cleanupOpenShellWorkspace({
        command,
        env: { ...process.env, FIXTURE_STATE: stateFile },
        workspace: "isolated",
        sandboxNames: ["first", "second", "never-created"],
      }),
    read: async () => JSON.parse(await fs.readFile(stateFile, "utf8")) as typeof initial,
    deadlineExpired: () => existsSync(stateFile + ".expired"),
  };
}

describe.runIf(process.platform !== "win32")("OpenShell workspace cleanup", () => {
  it.each(["not json", '[{"name":"someone-else"}]'])(
    "rejects inventory %j without deleting resources",
    async (inventory) => {
      const fixture = await createCleanupFixture({ inventory });
      await expect(fixture.cleanup()).rejects.toThrow();
      expect(await fixture.read()).toMatchObject({
        listCalls: 1,
        deletes: [],
        workspaceDeletes: 0,
      });
    },
  );

  it.each([
    ["read-failure", "database is locked", { listCalls: 2, deletes: ["first", "second"] }],
    ["delete-failure", "delete failed", { listCalls: 1, deletes: ["first", "second"] }],
    ["stuck", "120 seconds", { listCalls: 2, deletes: ["first"], observations: 1 }],
    ["workspace-failure", "workspace cleanup failed", { names: [], deletes: ["first", "second"] }],
  ] as const)("reports %s with durable deletion state", async (mode, message, state) => {
    const fixture = await createCleanupFixture({ mode });
    if (mode === "stuck") {
      const startedAt = Date.now();
      // Expire only after the child operation starts, even on a loaded host.
      vi.spyOn(Date, "now").mockImplementation(
        () => startedAt + (fixture.deadlineExpired() ? 120_000 : 0),
      );
    }
    if (mode === "workspace-failure") {
      await expect(fixture.cleanup()).rejects.toThrow(message);
    } else {
      const cleanup = fixture.cleanup();
      const errors = [expect.objectContaining({ message: expect.stringContaining(message) })];
      const expectedErrors = mode === "stuck" ? expect.arrayContaining(errors) : errors;
      await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
      await expect(cleanup).rejects.toHaveProperty("errors", expectedErrors);
    }
    expect(await fixture.read()).toMatchObject({
      ...state,
      workspaceDeletes: mode === "workspace-failure" ? 1 : 0,
    });
  });
});
