import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import type { CommandOptions } from "openclaw/plugin-sdk/process-runtime";
import type { ConfiguredModelEgress } from "openclaw/plugin-sdk/secret-egress-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { CRABBOX_MIN_VERSION, resolveManagedCrabboxBinaryPath } from "./crabbox-managed-binary.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), version: vi.fn(), withEgress: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: (argv: string[], params: CommandOptions) =>
    (argv[1] === "--version" ? mocks.version : mocks.run)(argv, params),
}));
vi.mock("openclaw/plugin-sdk/secret-egress-runtime", () => ({
  withConfiguredModelEgress: mocks.withEgress,
}));
const { registerCrabboxModelRunCommand } = await import("./crabbox-model-run-cli.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalExitCode = process.exitCode;
afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
});
const execFileAsync = promisify(execFile);
const capabilityHelp = "  -upstream-proxy-env string\n";
const egress: ConfiguredModelEgress = {
  sentinel: "oc-sent-v2.synthetic-placeholder.end",
  baseUrl: "https://api.example.com/v1/",
  model: "example-model",
  allowedHosts: ["api.example.com"],
  hostEnv: { HTTPS_PROXY: "http://openclaw:proxy-password-fixture@127.0.0.1:43210" },
  caBundle: "public-ca-fixture\n",
};
async function run(timeout = "60") {
  const program = new Command().exitOverride();
  registerCrabboxModelRunCommand({ program, config: {} });
  await program.parseAsync(
    `crabbox run --binary crabbox-fixture --id cbx_owned --model example/example-model --timeout ${timeout} -- node test-app.js`.split(
      " ",
    ),
    { from: "user" },
  );
}

beforeEach(() => {
  mocks.run.mockReset().mockResolvedValueOnce(commandResult({ stdout: capabilityHelp }));
  mocks.version.mockReset().mockResolvedValue(commandResult({ stdout: CRABBOX_MIN_VERSION }));
  mocks.withEgress.mockReset().mockImplementation(async (_options, invoke) => await invoke(egress));
});

it.each(["0x10", "1e3", "0b101", "0o17"])(
  "rejects non-decimal timeout %s before external calls",
  async (timeout) => {
    await expect(run(timeout)).rejects.toThrow(
      "--timeout must be an integer between 1 and 86400 seconds",
    );
    expect(mocks.version).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.withEgress).not.toHaveBeenCalled();
  },
);

it("runs an upgraded native job with a host-only proxy grant and sentinel-only app environment", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-model-managed-"));
  const binary = resolveManagedCrabboxBinaryPath();
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, CRABBOX_MIN_VERSION);
  mocks.version.mockImplementation(async ([candidate]: string[]) =>
    commandResult({ stdout: candidate === "crabbox-fixture" ? "0.76.0" : CRABBOX_MIN_VERSION }),
  );
  let remoteInput = "";
  mocks.run.mockImplementation(async (argv: string[], params: CommandOptions) => {
    expect(argv).toEqual([
      binary,
      ..."egress run --id cbx_owned --allow api.example.com --upstream-proxy-env CRABBOX_MODEL_PROXY --no-sync --no-hydrate --script-stdin -- node test-app.js".split(
        " ",
      ),
    ]);
    expect(params).toMatchObject({
      env: { CRABBOX_MODEL_PROXY: egress.hostEnv.HTTPS_PROXY, CRABBOX_ENV_ALLOW: "," },
    });
    expect(params.killGraceMs).toBeGreaterThan(60_000);
    expect(argv.join(" ")).not.toContain("proxy-password-fixture");
    remoteInput = String(params.input);
    expect(remoteInput).not.toContain("proxy-password-fixture");
    return commandResult({ code: 7 });
  });
  await run();
  expect(process.exitCode).toBe(7);
  expect(mocks.run.mock.calls.map(([argv]) => argv[0])).toEqual([binary, binary]);

  const fixture = `const fs = require('fs'); console.log(JSON.stringify({
      key: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL, proxy: process.env.HTTPS_PROXY,
      ca: fs.readFileSync(process.env.SSL_CERT_FILE, 'utf8'), path: process.env.SSL_CERT_FILE
    }));`;
  const child = execFileAsync("bash", ["-s", "--", process.execPath, "-e", fixture], {
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  child.child.stdin!.end(remoteInput);
  const observed = JSON.parse((await child).stdout);
  expect(observed).toMatchObject({
    key: egress.sentinel,
    baseUrl: egress.baseUrl,
    model: egress.model,
    proxy: "http://127.0.0.1:3128",
    ca: `${egress.caBundle}\n`,
  });
  await expect(execFileAsync("test", ["-e", observed.path])).rejects.toThrow();
});

it("refuses lookalike native flags before credential access", async () => {
  mocks.run
    .mockReset()
    .mockResolvedValue(
      commandResult({ stdout: "  --upstream-proxy-env-name string\n per-upstream-proxy-env help" }),
    );
  await expect(run()).rejects.toThrow("lacks native egress run");
  expect(mocks.withEgress).not.toHaveBeenCalled();
});

it("reports unconfirmed native process cleanup as failure", async () => {
  mocks.run.mockResolvedValue(commandResult({ cleanup: "uncertain" }));
  await expect(run()).rejects.toThrow("could not confirm");
});
