import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SECRET_FILE_MAX_BYTES } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStateSchemaInlinePlugin } from "../../../scripts/lib/state-schema-inline-plugin.mjs";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";
import { createTrustedNodeFixture } from "./trusted-node.test-support.js";

const sourceResolverPath = fileURLToPath(
  new URL("../onepassword-secret-ref-resolver.js", import.meta.url),
);
const sourceStaticAssetPaths = [
  sourceResolverPath,
  fileURLToPath(new URL("../onepassword-op-path.js", import.meta.url)),
  fileURLToPath(new URL("../onepassword-secret-id.js", import.meta.url)),
];
const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const rootTsconfigPath = path.resolve("tsconfig.json");
// The manifest test reads the production source; the timeout-only staged executable needs a
// shorter deadline to prove cleanup without sleeping for the production seven seconds.
const TEST_OP_READ_TIMEOUT_MS = process.platform === "win32" ? 5_000 : 1_500;
const secretId = "op://Engineering/OpenRouter/apiKey";
const serviceToken = "not-a-real-service-account-token";
let fixtureWorkspace: TempWorkspaceSync;
let stateWorkspace: TempWorkspaceSync;
let resolverPath = sourceResolverPath;
let timeoutResolverPath: string;
let stagedResolverRoot: string | undefined;
let trustedNodeRoot: string | undefined;
let trustedNodePath: string;
let receipts: FixtureReceiptChannel;

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
  const tempRoot = path.join(process.cwd(), ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  stagedResolverRoot = fs.mkdtempSync(path.join(tempRoot, "onepassword-resolver-"));
  for (const sourcePath of sourceStaticAssetPaths) {
    const stagedPath = path.join(stagedResolverRoot, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, stagedPath);
  }
  resolverPath = path.join(stagedResolverRoot, path.basename(sourceResolverPath));
  const resolverSource = fs.readFileSync(sourceResolverPath, "utf8");
  const timeoutResolverSource = resolverSource.replace(
    "const OP_READ_TIMEOUT_MS = 7_000;",
    `const OP_READ_TIMEOUT_MS = ${TEST_OP_READ_TIMEOUT_MS};`,
  );
  if (timeoutResolverSource === resolverSource) {
    throw new Error("failed to shorten the staged 1Password resolver timeout");
  }
  timeoutResolverPath = path.join(stagedResolverRoot, "onepassword-timeout-resolver.js");
  fs.writeFileSync(timeoutResolverPath, timeoutResolverSource);
  // Build the real SDK once; each request still gets a fresh process and real op execution.
  // Keep native dependencies external and use the production schema-asset transform.
  const compiledRoot = path.join(stagedResolverRoot, "compiled");
  await build({
    config: false,
    entry: [resolverPath, timeoutResolverPath],
    outDir: compiledRoot,
    tsconfig: rootTsconfigPath,
    format: "esm",
    outExtensions: () => ({ js: ".js" }),
    dts: false,
    deps: {
      neverBundle: true,
      alwaysBundle: [/^openclaw\//, /^@openclaw\/(?!fs-safe(?:\/|$))/],
    },
    plugins: [createStateSchemaInlinePlugin()],
  });
  resolverPath = path.join(compiledRoot, path.basename(resolverPath));
  timeoutResolverPath = path.join(compiledRoot, path.basename(timeoutResolverPath));
  // The fake op paths remain per-test; only their trusted Node interpreter is shared.
  // Re-copying the runtime does not strengthen path-ownership coverage.
  trustedNodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-1password-node-"));
  trustedNodePath = createTrustedNodeFixture(trustedNodeRoot);
});

afterAll(async () => {
  await receipts?.close();
  if (stagedResolverRoot) {
    fs.rmSync(stagedResolverRoot, { recursive: true, force: true });
  }
  if (trustedNodeRoot) {
    fs.rmSync(trustedNodeRoot, { recursive: true, force: true });
  }
});

function writeOpScript(opPath: string, body: string): void {
  fs.writeFileSync(opPath, `#!${trustedNodePath}\n${body}`, { mode: 0o755 });
}

function writeToken(stateDir: string, token: string): void {
  const tokenDir = path.join(stateDir, "credentials", "onepassword");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, "service-account-token"), token, { mode: 0o600 });
}

function runOp(body: string, params: Parameters<typeof runResolver>[0] = {}) {
  const opPath = path.join(fixtureWorkspace.dir, "op");
  writeOpScript(opPath, body);
  return runResolver({ ...params, env: { CLAW_1PASSWORD_OP: opPath, ...params.env } });
}

function expectFailure(result: Awaited<ReturnType<typeof runResolver>>) {
  expect(result).toEqual({ code: 1, stdout: "", stderr: "1Password SecretRef resolver failed.\n" });
}

function expectValues(
  result: Awaited<ReturnType<typeof runResolver>>,
  values: Record<string, string>,
) {
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout).values).toEqual(values);
}

function expectError(result: Awaited<ReturnType<typeof runResolver>>, message: string) {
  expect(JSON.parse(result.stdout).errors).toEqual({ [secretId]: { message } });
}

async function expectExited(pid: number) {
  await expect
    .poll(() => (isProcessAlive(pid) ? `descendant ${pid} is still alive` : "exited"), {
      timeout: 2_000,
      interval: 10,
    })
    .toBe("exited");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runResolver(params: {
  ids?: string[];
  cwd?: string;
  env?: Record<string, string>;
  resolverExecutablePath?: string;
  token?: string | null;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const stateDir = params.env?.OPENCLAW_STATE_DIR || stateWorkspace.dir;
  if (params.token !== null) {
    writeToken(stateDir, params.token ?? serviceToken);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [params.resolverExecutablePath ?? resolverPath], {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OP_SERVICE_ACCOUNT_TOKEN: "",
        CLAW_1PASSWORD_OP: "",
        OPENCLAW_STATE_DIR: stateDir,
        ...params.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(
      `${JSON.stringify({
        protocolVersion: 1,
        provider: "onepassword",
        ids: params.ids ?? [secretId],
      })}\n`,
    );
  });
}

function workspace() {
  return tempWorkspaceSync({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-1password-test-",
  });
}

beforeEach(() => {
  fixtureWorkspace = workspace();
  // Executable fixtures can become unsafe; keep the token's parent independently trusted.
  stateWorkspace = workspace();
});

afterEach(() => {
  fixtureWorkspace.cleanup();
  stateWorkspace.cleanup();
});

describe("plugin manifest", () => {
  it("declares the 1Password resolver as a managed Node SecretRef preset", () => {
    const resolverSource = fs.readFileSync(sourceResolverPath, "utf8");
    const readIntegerConstant = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d[\\d_]*)`, "u").exec(resolverSource);
      return Number(match?.[1]?.replaceAll("_", ""));
    };
    const opReadConcurrency = readIntegerConstant("OP_READ_CONCURRENCY");
    const opReadTimeoutMs = readIntegerConstant("OP_READ_TIMEOUT_MS");
    const maxRefsPerRequest = readIntegerConstant("MAX_SECRET_REFS_PER_REQUEST");
    const maxSecretValueBytes = readIntegerConstant("MAX_SECRET_VALUE_BYTES");
    const worstCaseBatchTimeoutMs =
      Math.ceil(maxRefsPerRequest / opReadConcurrency) * opReadTimeoutMs;
    const worstCaseEscapedValueBytes = Buffer.byteLength(
      JSON.stringify("\0".repeat(maxSecretValueBytes)),
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      commandAliases?: Array<{ name?: string; cliCommand?: string }>;
      secretProviderIntegrations?: Record<string, Record<string, unknown>>;
    };
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      openclaw?: {
        build?: {
          staticAssets?: Array<{ source?: string; output?: string }>;
        };
      };
    };
    const integration = manifest.secretProviderIntegrations?.onepassword;

    expect(manifest.commandAliases).toContainEqual({
      name: "onepassword",
      cliCommand: "onepassword",
    });
    expect(integration).toMatchObject({
      providerAlias: "onepassword",
      source: "exec",
      command: "${node}",
      args: ["./onepassword-secret-ref-resolver.js"],
      timeoutMs: 90_000,
      noOutputTimeoutMs: 90_000,
      maxOutputBytes: 16 * 1024 * 1024,
      passEnv: expect.arrayContaining([
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_PROFILE",
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
      ]),
    });
    for (const key of [
      "OP_SERVICE_ACCOUNT_TOKEN",
      "OP_CONNECT_HOST",
      "OP_CONNECT_TOKEN",
      "OP_ACCOUNT",
      "OP_CACHE",
    ]) {
      expect(integration?.passEnv).not.toContain(key);
    }
    expect(integration).not.toHaveProperty("trustedDirs");
    expect(integration?.timeoutMs).toBeGreaterThan(worstCaseBatchTimeoutMs);
    expect(integration?.noOutputTimeoutMs).toBeGreaterThan(worstCaseBatchTimeoutMs);
    expect(integration?.maxOutputBytes).toBeGreaterThan(
      maxRefsPerRequest * worstCaseEscapedValueBytes,
    );
    for (const name of [
      "onepassword-op-path.js",
      "onepassword-secret-ref-resolver.js",
      "onepassword-secret-id.js",
    ]) {
      expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
        source: `./${name}`,
        output: name,
      });
    }
  });
});

describe("1Password SecretRef resolver", () => {
  it.runIf(process.platform === "win32")(
    "preserves the Windows profile directories required by op",
    async () => {
      const tempDir = fixtureWorkspace.dir;
      const profile = path.join(tempDir, "profile");
      const localAppData = path.join(profile, "AppData", "Local");
      const directories = {
        USERPROFILE: profile,
        APPDATA: path.join(profile, "AppData", "Roaming"),
        LOCALAPPDATA: localAppData,
        TEMP: path.join(localAppData, "Temp"),
        TMP: path.join(localAppData, "Tmp"),
      };
      for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(
        path.join(tempDir, "read"),
        `process.stdout.write(JSON.stringify({
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  serviceAccount: process.env.OP_SERVICE_ACCOUNT_TOKEN === "not-a-real-service-account-token",
}));\n`,
      );

      const result = await runResolver({
        cwd: tempDir,
        env: {
          CLAW_1PASSWORD_OP: process.execPath,
          HOME: path.join(tempDir, "wrong-home"),
          ...directories,
        },
      });

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(JSON.parse(result.stdout).values[secretId])).toEqual({
        ...directories,
        serviceAccount: true,
      });
    },
  );

  it("escapes shorthand ids that begin with the opaque encoding prefix", async () => {
    const nativeRef = "opb64:team/item/field";
    const encodedId = encodeOnePasswordSecretId(nativeRef);

    expect(encodedId).toMatch(/^opb64:[A-Za-z0-9_-]+$/);
    expect(encodedId).not.toBe(nativeRef);
  });

  it("requires an absolute op CLI path", async () => {
    expectFailure(await runResolver({ env: { CLAW_1PASSWORD_OP: "op" } }));
  });

  it("rejects oversized batches before reading credentials or starting op", async () => {
    const ids = Array.from(
      { length: 33 },
      (_, index) => `op://Engineering/Item${index}/credential`,
    );
    const result = await runResolver({
      ids,
      env: { CLAW_1PASSWORD_OP: "/does/not/exist/op" },
      token: null,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = JSON.parse(result.stdout) as {
      values: Record<string, string>;
      errors: Record<string, { message: string }>;
    };
    expect(response.values).toEqual({});
    expect(Object.keys(response.errors)).toEqual(ids);
    expect(new Set(Object.values(response.errors).map((error) => error.message))).toEqual(
      new Set(["1Password SecretRef resolver supports at most 32 references per request."]),
    );
  });

  it.each([
    { name: "requires the broker token file", token: null },
    {
      name: "rejects an oversized broker token",
      token: "x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1),
    },
  ])("$name", async ({ token }) => {
    expectFailure(await runResolver({ env: { CLAW_1PASSWORD_OP: process.execPath }, token }));
  });

  it(
    "kills the op process tree when a read times out",
    async ({ signal }) => {
      const tempDir = fixtureWorkspace.dir;
      const descendantPidPath = path.join(tempDir, "timed-out-descendant.pid");
      const descendantBody = `import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(`${descendantPidPath}.tmp`)}, String(process.pid));
fs.renameSync(${JSON.stringify(`${descendantPidPath}.tmp`)}, ${JSON.stringify(descendantPidPath)});
sendReceipt(${JSON.stringify(descendantPidPath)}, "ready");
setInterval(() => {}, 1000);
`;
      let opPath = process.execPath;
      if (process.platform === "win32") {
        const opBody = `const { spawn } = require("node:child_process");
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantBody)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
        fs.writeFileSync(path.join(tempDir, "read"), opBody);
      } else {
        // Executable trust validation requires the literal shebang path to be canonical.
        const shellPath = fs.realpathSync("/bin/sh");
        const descendantPath = path.join(tempDir, "descendant.mjs");
        opPath = path.join(tempDir, "op");
        fs.writeFileSync(descendantPath, descendantBody);
        fs.writeFileSync(
          opPath,
          `#!${shellPath}
${JSON.stringify(trustedNodePath)} ${JSON.stringify(descendantPath)} &
while true; do sleep 1; done
`,
          { mode: 0o755 },
        );
      }

      const resultPromise = runResolver({
        cwd: tempDir,
        env: { CLAW_1PASSWORD_OP: opPath },
        resolverExecutablePath: timeoutResolverPath,
      });
      let descendantPid: number | undefined;
      try {
        // The PID record precedes the receipt, but the resolver's exit uses another pipe.
        // If exit wins, the durable record still proves SIGTERM immunity was installed.
        await withinTest(
          Promise.race([
            receipts.waitFor(descendantPidPath, "ready"),
            resultPromise.then((result) => {
              if (!fs.existsSync(descendantPidPath)) {
                throw new Error(
                  `Resolver exited before the descendant was ready: ${JSON.stringify(result)}`,
                );
              }
            }),
          ]),
          signal,
        );
        const pid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        descendantPid = pid;
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        const result = await withinTest(resultPromise, signal);
        expectError(result, `op read timed out after ${TEST_OP_READ_TIMEOUT_MS}ms.`);
        await expectExited(pid);
      } finally {
        // Join resolver-owned cleanup even when the test aborts before readiness arrives.
        await resultPromise;
        if (descendantPid === undefined && fs.existsSync(descendantPidPath)) {
          descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
    process.platform === "win32" ? 30_000 : 15_000,
  );

  describe.runIf(process.platform !== "win32")("POSIX op execution", () => {
    it("uses op read with native 1Password secret references", async () => {
      const tempDir = fixtureWorkspace.dir;
      const logPath = path.join(tempDir, "op-args.json");
      const result = await runOp(
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args: process.argv.slice(2),
  biometric: process.env.OP_BIOMETRIC_UNLOCK_ENABLED,
  loadDesktopSettings: process.env.OP_LOAD_DESKTOP_APP_SETTINGS,
  account: process.env.OP_ACCOUNT,
  serviceAccount: process.env.OP_SERVICE_ACCOUNT_TOKEN === "not-a-real-service-account-token",
}));
process.stdout.write("not-a-real-value \\t");
`,
        {
          env: {
            OP_ACCOUNT: "should-not-reach-op",
          },
        },
      );

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: {
          [secretId]: "not-a-real-value \t",
        },
        errors: {},
      });
      expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toEqual({
        args: ["read", "--cache=false", "--no-newline", "op://Engineering/OpenRouter/apiKey"],
        biometric: "false",
        loadDesktopSettings: "false",
        serviceAccount: true,
      });
    });

    it("waits for inherited op stdout to close before returning the secret", async () => {
      const result = await runOp(
        `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('tail'), 50)"], {
  stdio: ["ignore", process.stdout, "ignore"],
});
process.stdout.write("head");
`,
        {
          ids: ["Engineering/OpenRouter/apiKey"],
        },
      );

      expect(JSON.parse(result.stdout).values).toEqual({
        "Engineering/OpenRouter/apiKey": "headtail",
      });
    });

    it("rejects a symlinked broker token file", async () => {
      const stateDir = fixtureWorkspace.dir;
      const tokenDir = path.join(stateDir, "credentials", "onepassword");
      const targetPath = path.join(tokenDir, "service-account-token-target");
      const tokenPath = path.join(tokenDir, "service-account-token");
      fs.mkdirSync(tokenDir, { recursive: true });
      fs.writeFileSync(targetPath, "linked-service-account-token", { mode: 0o600 });
      fs.symlinkSync(targetPath, tokenPath);

      const result = await runResolver({
        env: { CLAW_1PASSWORD_OP: process.execPath, OPENCLAW_STATE_DIR: stateDir },
        token: null,
      });

      expectFailure(result);
    });

    it("reads the service token from the selected profile state directory", async () => {
      const home = fixtureWorkspace.dir;
      writeToken(path.join(home, ".openclaw-work"), "profile-token");
      writeToken(path.join(home, ".openclaw"), "default-token");

      const result = await runOp(`process.stdout.write(process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`, {
        env: {
          HOME: home,
          OPENCLAW_HOME: "",
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: "",
        },
        token: null,
      });

      expectValues(result, { [secretId]: "profile-token" });
    });

    it.each([
      {
        name: "state dir",
        directory: "oc-state",
        home: "",
        state: "~/oc-state",
        token: "dollar-token",
      },
      {
        name: "OPENCLAW_HOME",
        directory: "oc-home/.openclaw",
        home: "~/oc-home",
        state: "",
        token: "home-token",
      },
    ])(
      "preserves literal $ in HOME when expanding tilde $name",
      async ({ directory, home: openclawHome, state, token }) => {
        const home = path.join(fixtureWorkspace.dir, "home$&d");
        writeToken(path.join(home, directory), token);
        const result = await runOp(
          "process.stdout.write(process.env.OP_SERVICE_ACCOUNT_TOKEN);\n",
          {
            env: {
              HOME: home,
              OPENCLAW_PROFILE: "",
              OPENCLAW_HOME: openclawHome,
              OPENCLAW_STATE_DIR: state,
            },
            token: null,
          },
        );
        expectValues(result, { [secretId]: token });
      },
    );

    it("keeps the exit-code diagnostic when failed op read has no stderr", async () => {
      const result = await runOp(
        `process.stdout.write("secret-output-must-not-escape");
process.exitCode = 1;
`,
      );
      expect(result.stdout).not.toContain("secret-output-must-not-escape");
      expectError(result, "op read failed with exit code 1.");
    });

    it("reports a bounded redacted stderr tail without exposing op read secrets", async () => {
      const result = await runOp(
        `process.stdout.write("fixture-secret-output");
process.stderr.write("discarded-prefix " + "x".repeat(2_000) + "\\n");
process.stderr.write(process.env.OP_SERVICE_ACCOUNT_TOKEN + "\\nfixture-secret-output\\n");
process.stderr.write("password=" + "fixture-private-password".repeat(40) + "\\nnot signed in; item not found\\n");
process.exitCode = 1;
`,
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const response = JSON.parse(result.stdout) as {
        values: Record<string, string>;
        errors: Record<string, { message: string }>;
      };
      expect(response.values).toEqual({});
      const message = response.errors[secretId]?.message;
      expect(message).toBeDefined();
      expect(message).toMatch(/^op read failed with exit code 1\./);
      expect(message).toMatch(/not signed in; item not found$/);
      expect(message?.length).toBeLessThanOrEqual("op read failed with exit code 1. ".length + 512);
      for (const hidden of [
        "discarded-prefix",
        "not-a-real-service-account-token",
        "fixture-secret-output",
        "fixture-private-password",
      ]) {
        expect(result.stdout).not.toContain(hidden);
      }
    });

    it("kills the op process tree when output exceeds the limit", async () => {
      const tempDir = fixtureWorkspace.dir;
      const descendantPidPath = path.join(tempDir, "descendant.pid");

      let descendantPid: number | undefined;
      try {
        const result = await runOp(`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
descendant.once("spawn", () => {
  fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
  process.stdout.write("x".repeat(70 * 1024));
});
setInterval(() => {}, 1000);
`);
        expectError(result, "op read output exceeded the limit.");
        const pid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
        descendantPid = pid;
        expect(pid).toBeGreaterThan(0);
        await expectExited(pid);
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    });

    it("bounds concurrent op reads", async () => {
      const tempDir = fixtureWorkspace.dir;
      const logPath = path.join(tempDir, "events.log");

      const ids = Array.from({ length: 20 }, (_, index) => `op://Vault/Item${index}/field`);
      const result = await runOp(
        `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "start " + process.pid + "\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "end " + process.pid + "\\n");
  process.stdout.write("not-a-real-value");
}, 80);
`,
        { ids },
      );

      expect(Object.keys(JSON.parse(result.stdout).values)).toHaveLength(ids.length);
      let active = 0;
      let maxActive = 0;
      for (const event of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
        active += event.startsWith("start ") ? 1 : -1;
        maxActive = Math.max(maxActive, active);
      }
      expect(maxActive).toBeLessThanOrEqual(4);
    });

    it("refuses to pass the token to an op CLI in an unsafe PATH directory", async () => {
      const tempDir = fixtureWorkspace.dir;
      const opPath = path.join(tempDir, "op");
      const tokenLogPath = path.join(tempDir, "token.log");
      writeOpScript(
        opPath,
        `require("node:fs").writeFileSync(${JSON.stringify(tokenLogPath)}, process.env.OP_SERVICE_ACCOUNT_TOKEN);\n`,
      );
      fs.chmodSync(tempDir, 0o777);

      const result = await runResolver({
        env: { PATH: tempDir },
      });

      expectFailure(result);
      expect(fs.existsSync(tokenLogPath)).toBe(false);
    });
  });
});
