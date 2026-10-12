import { createRequire } from "node:module";
import path from "node:path";
import { inspect } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";

const leaseId = "cbx_bootstrap_test";
const setupCode = "synthetic-enrollment-credential";

it.each([
  { status: 7, signal: null, error: undefined },
  { status: null, signal: "SIGKILL", error: new Error("probe timed out") },
])("reports sanitized runtime probe failure ($status, $signal)", async (probe) => {
  const nodeBootstrap = createNodeBootstrapFixture();
  const setup = createCrabboxNodeEnrollmentSetup({
    leaseId,
    enrollment: {
      mode: "connect",
      setupId: "synthetic-setup",
      setupCode,
      displayName: "fixture",
      openclawVersion: nodeBootstrap.openclawVersion,
      nodeBootstrap,
      waitForDeviceId: async () => "unused",
    },
  });
  const runtime = path.join("/fixture", ".openclaw-worker", "node-runtimes", nodeBootstrap.sha256);
  const output: string[] = [];
  const envValue = "synthetic-private-environment-value";
  const processFixture = {
    platform: "linux",
    execPath: "/node",
    umask: () => {},
    exitCode: 0,
    env: { ...setup.forwardedEnv, PRIVATE_FIXTURE: envValue },
  };
  const require = createRequire(import.meta.url);
  const failures: Error[] = [];
  class ScriptError extends Error {
    constructor(message?: string, options?: ErrorOptions) {
      super(message, options);
      if (options?.cause !== undefined) {
        failures.push(this);
      }
    }
  }
  await runInNewContext(setup.command.split("\n").slice(2, -1).join("\n"), {
    Buffer,
    AbortController,
    Error: ScriptError,
    process: processFixture,
    console: { error: (line: string) => output.push(line) },
    require: (name: string) =>
      name === "node:os"
        ? { homedir: () => "/fixture" }
        : name === "node:fs"
          ? {
              promises: {},
              mkdirSync: () => {},
              chmodSync: () => {},
              existsSync: (file: string) => file === runtime,
              realpathSync: (file: string) => file,
              lstatSync: (file: string) => {
                if (file === runtime) {
                  return { isDirectory: () => true };
                }
                throw Object.assign(new Error("missing fixture path"), { code: "ENOENT" });
              },
              readFileSync: () =>
                JSON.stringify({ name: "openclaw", version: nodeBootstrap.openclawVersion }),
            }
          : name === "node:child_process"
            ? {
                spawnSync: () => ({
                  ...probe,
                  stdout: "",
                  stderr:
                    "old output 😀 ".repeat(100) +
                    `runtime dependency missing ${envValue} ${nodeBootstrap.token} ${setupCode} token=synthetic-unknown-token`,
                }),
              }
            : require(name),
  });
  const detail = output.at(-1)!;
  expect(processFixture.exitCode).toBe(1);
  expect(detail).toContain("could not verify its Gateway version");
  expect(detail).toContain(`exit code ${probe.status ?? "unknown"}`);
  expect(detail).toContain(`signal ${probe.signal ?? "none"}`);
  expect(detail).toContain("runtime dependency missing");
  expect(detail).not.toContain("synthetic-");
  expect(detail).not.toContain("�");
  expect(Buffer.byteLength(detail)).toBeLessThan(800);
  const failure = failures.at(-1);
  expect(failure).toMatchObject({ cause: expect.any(Error) });
  for (let current: unknown = failure; current instanceof Error; current = current.cause) {
    expect(current.message).not.toContain("synthetic-");
  }
  expect(inspect(failure, { depth: null })).not.toContain("synthetic-");
});
