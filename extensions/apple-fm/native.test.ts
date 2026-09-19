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
let directory: string;
let native: AppleFmNative;
const success = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

beforeEach(async () => {
  native = createAppleFmNative(fileURLToPath(new URL(".", import.meta.url)));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "apple-fm-native-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(directory);
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  Object.defineProperty(process, "arch", { ...originalArch, value: "arm64" });
  vi.spyOn(os, "release").mockReturnValue("26.0.0");
  vi.mocked(runCommandBuffered).mockReset();
  vi.mocked(runCommandBuffered).mockImplementation(async (argv) => {
    if (argv[0] === "/usr/bin/xcode-select") {
      return success("/Applications/Xcode.app/Contents/Developer\n");
    }
    if (argv[0] === "/usr/bin/xcrun") {
      await fs.writeFile(argv.at(-1)!, "synthetic executable", { mode: 0o700 });
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
  it("discovers a cold model without installing a helper or enabling inference", async () => {
    expect(await native.probe()).toEqual(facts);
    expect(await fs.readdir(directory)).toEqual([]);
    await expect(native.run({ messages: [] })).rejects.toThrow("setup again");
  });

  it("cleans up cold discovery on cancellation without publishing an executable", async () => {
    const abort = new AbortController();
    vi.mocked(runCommandBuffered).mockImplementation(async (argv) => {
      if (argv[0] === "/usr/bin/xcrun") {
        await fs.writeFile(argv.at(-1)!, "synthetic executable");
        abort.abort();
      }
      return success();
    });
    await expect(native.probe({ signal: abort.signal })).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
    await expect(native.run({ messages: [] })).rejects.toThrow("setup again");
  });

  it.each(["linux", "win32"])("does not probe or compile on %s", async (platform) => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    expect(await native.probe()).toBeNull();
    expect(runCommandBuffered).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("installs a helper during selected setup and reuses it for discovery and inference", async () => {
    const first = await native.prepare();
    expect(first).toMatchObject(facts);
    expect(await native.probe()).toEqual(facts);
    const second = await native.prepare();
    expect(second).toEqual(first);
    expect(
      vi.mocked(runCommandBuffered).mock.calls.filter(([argv]) => argv[0] === "/usr/bin/xcrun"),
    ).toHaveLength(1);
    expect(
      vi.mocked(runCommandBuffered).mock.calls.every(([, options]) => options?.input === ""),
    ).toBe(true);
    expect(
      vi
        .mocked(runCommandBuffered)
        .mock.calls.every(([, options]) => !options?.baseEnv?.OPENAI_API_KEY),
    ).toBe(true);
  });

  it("does not publish a compiled helper when setup is canceled", async () => {
    const abort = new AbortController();
    vi.mocked(runCommandBuffered).mockImplementation(async (argv) => {
      if (argv[0] === "/usr/bin/xcrun") {
        await fs.writeFile(argv.at(-1)!, "synthetic executable");
        abort.abort();
      }
      return success();
    });
    await expect(native.prepare({ signal: abort.signal })).rejects.toThrow();
    await expect(native.run({ messages: [] })).rejects.toThrow("setup again");
    const [buildRoot] = await fs.readdir(path.join(directory, "tools", "apple-fm"));
    expect(await fs.readdir(path.join(directory, "tools", "apple-fm", buildRoot!))).toEqual([]);
  });

  it("reports missing developer tools without starting an installer", async () => {
    vi.mocked(runCommandBuffered).mockResolvedValue({ ...success(), code: 1 });
    await expect(native.probe()).rejects.toThrow("does not install developer tools automatically");
    expect(runCommandBuffered).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("preserves large numeric tool identifiers without rounding them", async () => {
    await native.prepare();
    vi.mocked(runCommandBuffered).mockResolvedValue(
      success(
        '{"text":"","toolCalls":[{"id":"call-1","name":"lookup","arguments":{"id":9007199254740993}}],"inputTokens":10,"outputTokens":10}',
      ),
    );
    expect((await native.run({ messages: [] })).toolCalls[0]?.arguments.id).toBe(
      "9007199254740993",
    );
  });

  it("preserves native context errors and rejects malformed helper output", async () => {
    await native.prepare();
    vi.mocked(runCommandBuffered).mockResolvedValue(
      success(JSON.stringify({ error: "Content exceeds the context size of 8192" })),
    );
    await expect(native.run({ messages: [] })).rejects.toThrow("context size of 8192");
    vi.mocked(runCommandBuffered).mockResolvedValue(
      success(JSON.stringify({ text: "partial", toolCalls: [{ name: "unknown" }] })),
    );
    await expect(native.run({ messages: [] })).rejects.toThrow();
  });
});
