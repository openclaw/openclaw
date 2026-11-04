import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { OnePasswordError } from "./errors.js";
import { OpClient } from "./op-client.js";
import { createTrustedNodeFixture } from "./trusted-node.test-support.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runExec: vi.fn(),
}));
const runner = vi.mocked(runExec);

let root = "";
let opBin = "";
let interpreter = "";
let interpreterRoot: string | undefined;
let tokenFile = "";
const fixtureAuth = ["fixture", "auth"].join("-");
const value = ["right", "fixture"].join("-");
const request = { item: "Token", vault: "Automation", field: "credential" };
const client = (options: Partial<ConstructorParameters<typeof OpClient>[0]> = {}) =>
  new OpClient({ opBin, tokenFile, timeoutMs: 1000, ...options });
const read = (instance = client()) => instance.getItem(request);
const respond = (field: Record<string, string>) =>
  runner.mockResolvedValue({ stdout: JSON.stringify(field), stderr: "" });

beforeAll(async () => {
  // Only the immutable interpreter is shared; executable and token trust stay per-test.
  // openclaw-temp-dir: allow plugin tests cannot import the core-only tracker.
  interpreterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onepassword-node-"));
  interpreter = createTrustedNodeFixture(interpreterRoot);
});

afterAll(async () => {
  if (interpreterRoot) {
    await fs.rm(interpreterRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  // openclaw-temp-dir: allow plugin tests cannot import the core-only tracker.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onepassword-"));
  runner.mockReset();
  vi.spyOn(os, "homedir").mockReturnValue(root);
  opBin = path.join(root, process.platform === "win32" ? "op.exe" : "op");
  tokenFile = path.join(root, "service-account-token");
  await fs.writeFile(opBin, `#!${interpreter}\nprocess.exit(0);\n`, { mode: 0o700 });
  await fs.writeFile(tokenFile, `  ${fixtureAuth}\n`, { mode: 0o600 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("constructs one cache-disabled request with minimal environment and trims the token", async () => {
  respond({ id: "new", label: "credential", value });
  await expect(
    client({ timeoutMs: 1234 }).getItem({ ...request, item: "Repository token" }),
  ).resolves.toEqual({ value, itemTitle: "Repository token", fieldLabel: "credential" });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner).toHaveBeenCalledWith(
    await fs.realpath(opBin),
    [
      "item",
      "get",
      "Repository token",
      "--vault",
      "Automation",
      "--fields",
      "credential",
      "--format",
      "json",
      "--cache=false",
    ],
    {
      baseEnv: {},
      env: {
        OP_SERVICE_ACCOUNT_TOKEN: fixtureAuth,
        HOME: root,
        OP_LOAD_DESKTOP_APP_SETTINGS: "false",
        OP_BIOMETRIC_UNLOCK_ENABLED: "false",
      },
      timeoutMs: 1234,
      maxBuffer: 1024 * 1024,
      logOutput: false,
    },
  );
});

it("rejects a mismatched field response without exposing its value", async () => {
  respond({ id: "one", label: "username", value: ["private", "user"].join("-") });
  const error = await read().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(OnePasswordError);
  expect(error).toMatchObject({ code: "FIELD_NOT_FOUND" });
  expect(String(error)).not.toContain("private-");
});

it("surfaces missing and empty token files as TOKEN_MISSING", async () => {
  await fs.rm(tokenFile);
  const instance = client();
  await expect(read(instance)).rejects.toMatchObject({ code: "TOKEN_MISSING" });
  expect(runner).not.toHaveBeenCalled();

  await fs.writeFile(tokenFile, " \n", { mode: 0o600 });
  await expect(read(instance)).rejects.toMatchObject({ code: "TOKEN_MISSING" });
});

it("rejects oversized token files before invoking the 1Password CLI", async () => {
  await fs.writeFile(tokenFile, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
  await expect(read()).rejects.toMatchObject({
    code: "TOKEN_MISSING",
    message: `1Password service account token file at ${tokenFile} exceeds 16384 bytes.`,
  });
  expect(runner).not.toHaveBeenCalled();
});

it("warns once for token file permissions broader than 0600", async () => {
  await fs.chmod(tokenFile, 0o644);
  const warn = vi.fn();
  respond({ label: "credential", value: "value" });
  const instance = client({ warn });
  await read(instance);
  await read(instance);
  expect(warn).toHaveBeenCalledTimes(1);
});

it.each([
  ["RATE_LIMITED", { stderr: "request failed: 429 rate limit", code: 1 }],
  ["ITEM_NOT_FOUND", { stderr: "item is not found", code: 1 }],
  ["FIELD_NOT_FOUND", { stderr: `"429 credential" isn't a field in the "Token" item`, code: 1 }],
  ["AUTH_FAILED", { stderr: "unauthorized service account", code: 1 }],
  ["TIMEOUT", { stderr: "", timedOut: true }],
  ["OP_ERROR", { stderr: "unexpected failure", code: 1 }],
] as const)("maps process failure to %s without retry", async (expectedCode, failure) => {
  runner.mockRejectedValue(Object.assign(new Error("op failed"), failure));
  await expect(read()).rejects.toMatchObject({ code: expectedCode });
  expect(runner).toHaveBeenCalledTimes(1);
});

it.each(["unresolved", "removed"])("rejects an %s binary before execution", async (state) => {
  const instance = client(state === "unresolved" ? { opBin: path.join(root, "missing-op") } : {});
  if (state === "removed") {
    await fs.rm(opBin);
  }
  await expect(read(instance)).rejects.toMatchObject({ code: "OP_NOT_FOUND" });
  expect(runner).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")(
  "does not read or pass the token to an executable in an unsafe directory",
  async () => {
    await fs.chmod(root, 0o777);
    await expect(read()).rejects.toMatchObject({ code: "OP_NOT_FOUND" });
    expect(runner).not.toHaveBeenCalled();
  },
);
