import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandOptions, SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type { ConfiguredModelEgress } from "openclaw/plugin-sdk/secret-egress-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), withEgress: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandWithTimeout: mocks.run }));
vi.mock("openclaw/plugin-sdk/secret-egress-runtime", () => ({
  withConfiguredModelEgress: mocks.withEgress,
}));
const { runCrabboxModelCommand } = await import("./crabbox-model-run.js");
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
const options = {
  config: {},
  binary: "crabbox-fixture",
  id: "cbx_owned",
  model: "example/example-model",
  argv: ["node", "test-app.js"],
  timeoutMs: 60_000,
};
function result(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}
beforeEach(() => {
  mocks.run.mockReset();
  mocks.withEgress.mockReset();
  mocks.withEgress.mockImplementation(async (_options, run) => await run(egress));
});

describe("Crabbox protected model command", () => {
  it("delegates one native job with a host-only proxy grant and sentinel-only app environment", async () => {
    let remoteInput = "";
    mocks.run.mockImplementation(async (argv: string[], params: CommandOptions) => {
      if (argv.includes("--help")) {
        return result(capabilityHelp);
      }
      expect(argv).toEqual([
        "crabbox-fixture",
        "egress",
        "run",
        "--id",
        "cbx_owned",
        "--allow",
        "api.example.com",
        "--upstream-proxy-env",
        "CRABBOX_MODEL_PROXY",
        "--no-sync",
        "--no-hydrate",
        "--script-stdin",
        "--",
        "node",
        "test-app.js",
      ]);
      expect(params.env?.CRABBOX_MODEL_PROXY).toBe(egress.hostEnv.HTTPS_PROXY);
      expect(params.env?.CRABBOX_ENV_ALLOW).toBe(",");
      expect(params.killGraceMs).toBeGreaterThan(60_000);
      expect(argv.join(" ")).not.toContain("proxy-password-fixture");
      remoteInput = String(params.input);
      expect(remoteInput).not.toContain("proxy-password-fixture");
      return result("app finished\n", 7);
    });
    expect(await runCrabboxModelCommand(options)).toMatchObject({
      code: 7,
      stdout: "app finished\n",
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);

    const fixture = `const fs = require('fs'); console.log(JSON.stringify({
      key: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL, proxy: process.env.HTTPS_PROXY,
      ca: fs.readFileSync(process.env.SSL_CERT_FILE, 'utf8'), path: process.env.SSL_CERT_FILE
    }));`;
    const child = execFile("bash", ["-s", "--", process.execPath, "-e", fixture], {
      env: { ...process.env, NODE_OPTIONS: undefined },
    });
    const completion = new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve(output) : reject(new Error(`fixture exited ${code}`)),
      );
    });
    child.stdin!.end(remoteInput);
    const observed = JSON.parse(await completion);
    expect(observed).toMatchObject({
      key: egress.sentinel,
      baseUrl: egress.baseUrl,
      model: egress.model,
      proxy: "http://127.0.0.1:3128",
      ca: `${egress.caBundle}\n`,
    });
    await expect(execFileAsync("test", ["-e", observed.path])).rejects.toThrow();
  });

  it.each(["", "  --upstream-proxy-env-name string\n per-upstream-proxy-env help"])(
    "refuses incompatible native commands before credential access",
    async (help) => {
      mocks.run.mockResolvedValue(result(help));
      await expect(runCrabboxModelCommand(options)).rejects.toThrow("lacks native egress run");
      expect(mocks.withEgress).not.toHaveBeenCalled();
    },
  );

  it("reports unconfirmed native process cleanup as failure", async () => {
    mocks.run.mockResolvedValueOnce(result(capabilityHelp));
    mocks.run.mockResolvedValueOnce({ ...result(), cleanup: "uncertain" });
    await expect(runCrabboxModelCommand(options)).rejects.toThrow("could not confirm");
  });
});
