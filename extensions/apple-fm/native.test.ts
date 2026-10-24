import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppleFmNative, type AppleFmNative } from "./native.js";

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandBuffered: vi.fn() }));
vi.mock("openclaw/plugin-sdk/temp-path", () => ({ resolvePreferredOpenClawTmpDir: vi.fn() }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
const facts = { available: true, modelName: "AFM 3 Core Advanced", contextWindow: 8192 };
const command = vi.mocked(runCommandBuffered);
let directory: string;
let native: AppleFmNative;
let abortAfterCompile: AbortController | undefined;
const success = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

beforeEach(async () => {
  abortAfterCompile = undefined;
  native = createAppleFmNative(fileURLToPath(new URL(".", import.meta.url)));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "apple-fm-native-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(directory);
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  Object.defineProperty(process, "arch", { ...originalArch, value: "arm64" });
  vi.spyOn(os, "release").mockReturnValue("26.0.0");
  command.mockReset();
  command.mockImplementation(async (argv) => {
    if (argv[0] === "/usr/bin/xcode-select") {
      return success("/Applications/Xcode.app/Contents/Developer\n");
    }
    if (argv[0] === "/usr/bin/xcrun") {
      await fs.writeFile(argv.at(-1)!, "synthetic executable", { mode: 0o700 });
      abortAfterCompile?.abort();
      return success();
    }
    return success(JSON.stringify(facts));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Apple Foundation Models helper lifecycle", () => {
  it.each(["probe", "prepare"] as const)(
    "cleans up canceled %s without publishing a helper",
    async (operation) => {
      abortAfterCompile = new AbortController();
      await expect(native[operation]({ signal: abortAfterCompile.signal })).rejects.toThrow();
      await expect(native.run({ messages: [] })).rejects.toThrow("setup again");
      let root = directory;
      if (operation === "prepare") {
        root = path.join(directory, "tools", "apple-fm");
        const [buildRoot] = await fs.readdir(root);
        root = path.join(root, buildRoot!);
      }
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it("does not probe or compile on non-Mac hosts", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    expect(await native.probe()).toBeNull();
    expect(runCommandBuffered).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("keeps discovery disposable until selection installs a reusable helper", async () => {
    expect(await native.probe()).toEqual(facts);
    expect(await fs.readdir(directory)).toEqual([]);
    await expect(native.run({ messages: [] })).rejects.toThrow("setup again");
    const first = await native.prepare();
    expect(first).toMatchObject(facts);
    expect(await native.probe()).toEqual(facts);
    expect(await native.prepare()).toEqual(first);
    expect(
      command.mock.calls
        .filter(([argv]) => argv[0] === "/usr/bin/xcrun")
        .map(([argv]) => argv.filter((arg) => arg.startsWith("-O"))),
    ).toEqual([["-Onone"], ["-O"]]);
    expect(command.mock.calls.every(([, options]) => options?.input === "")).toBe(true);
    expect(command.mock.calls.every(([, options]) => !options?.baseEnv?.OPENAI_API_KEY)).toBe(true);
  });

  it("reports missing developer tools without starting an installer", async () => {
    command.mockResolvedValue({ ...success(), code: 1 });
    await expect(native.probe()).rejects.toThrow("does not install developer tools automatically");
    expect(runCommandBuffered).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("preserves native context errors and rejects malformed helper output", async () => {
    await native.prepare();
    command.mockResolvedValue(
      success(JSON.stringify({ error: "Content exceeds the context size of 8192" })),
    );
    await expect(native.run({ messages: [] })).rejects.toThrow("context size of 8192");
    command.mockResolvedValue(
      success(JSON.stringify({ text: "partial", toolCalls: [{ name: "unknown" }] })),
    );
    await expect(native.run({ messages: [] })).rejects.toThrow();
  });
});
