import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { parseJsonPreservingUnsafeIntegers } from "openclaw/plugin-sdk/json-unsafe-integers";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { z } from "zod";

export type AppleFmFacts = {
  available: boolean;
  reason?: string;
  modelName: string;
  contextWindow: number;
};

type NativeOptions = { signal?: AbortSignal; env?: NodeJS.ProcessEnv };
const SETUP_REQUIRED = "Run Apple Foundation Models setup again to build its native helper.";
const infoSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  modelName: z.string(),
  contextWindow: z.number().int().nonnegative(),
});
const resultSchema = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()),
    }),
  ),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type AppleFmResult = z.infer<typeof resultSchema>;

function supportsNativeModel(): boolean {
  return (
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    Number(os.release().split(".")[0]) >= 26
  );
}

function nativeEnvironment(env = process.env): NodeJS.ProcessEnv {
  return {
    HOME: env.HOME ?? os.homedir(),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}),
    ...(env.DEVELOPER_DIR ? { DEVELOPER_DIR: env.DEVELOPER_DIR } : {}),
  };
}

export function createAppleFmNative(pluginRoot: string) {
  const SOURCE = path.join(pluginRoot, "assets", "AppleFoundationModels.swift");
  let sourceDigest: Promise<string> | undefined;
  async function helperPath(env?: NodeJS.ProcessEnv): Promise<string> {
    sourceDigest ??= fs
      .readFile(SOURCE)
      .then((source) => createHash("sha256").update(source).digest("hex"));
    return path.join(
      resolveStateDir(env),
      "tools",
      "apple-fm",
      `${await sourceDigest}-${os.release().split(".")[0]}`,
      "helper",
    );
  }

  async function helperExists(command: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(command);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch (error) {
      if (extractErrorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async function invoke(
    command: string,
    args: string[],
    input: string,
    options: NativeOptions,
  ): Promise<unknown> {
    options.signal?.throwIfAborted();
    const result = await runCommandBuffered([command, ...args], {
      input,
      baseEnv: nativeEnvironment(options.env),
      signal: options.signal,
      timeoutMs: args[0] === "info" ? 15_000 : 120_000,
      maxOutputBytes: { stdout: 2 * 1024 * 1024, stderr: 8 * 1024 },
      killProcessTree: true,
    });
    options.signal?.throwIfAborted();
    if (result.code !== 0 || result.termination !== "exit") {
      throw new Error(
        `Apple Foundation Models helper failed (${result.termination}, exit ${result.code ?? "none"}). ${result.stderr.toString("utf8").trim()}`,
      );
    }
    const value: unknown = parseJsonPreservingUnsafeIntegers(result.stdout.toString("utf8"));
    const failure = z.object({ error: z.string() }).safeParse(value);
    if (failure.success) {
      throw new Error(failure.data.error);
    }
    return value;
  }

  async function probeAppleFm(options: NativeOptions = {}): Promise<AppleFmFacts | null> {
    options.signal?.throwIfAborted();
    if (!supportsNativeModel()) {
      return null;
    }
    const command = await helperPath(options.env);
    if (await helperExists(command)) {
      return infoSchema.parse(await invoke(command, ["info"], "", options));
    }
    // First-time discovery runs a disposable helper off-process. It must not install
    // anything in OpenClaw state before the user selects this model.
    const directory = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-apple-fm-probe-"),
    );
    const temporary = path.join(directory, "helper");
    const timeout = AbortSignal.timeout(30_000);
    const probeOptions = {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    };
    try {
      await compileHelper(temporary, probeOptions);
      return infoSchema.parse(await invoke(temporary, ["info"], "", probeOptions));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async function compileHelper(temporary: string, options: NativeOptions): Promise<void> {
    options.signal?.throwIfAborted();
    const developerTools = await runCommandBuffered(["/usr/bin/xcode-select", "-p"], {
      input: "",
      baseEnv: nativeEnvironment(options.env),
      signal: options.signal,
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024,
    });
    options.signal?.throwIfAborted();
    if (developerTools.code !== 0) {
      throw new Error(
        "Install Apple's developer tools with the macOS 27 SDK, then rerun Apple Foundation Models setup. OpenClaw does not install developer tools automatically.",
      );
    }
    const result = await runCommandBuffered(
      [
        "/usr/bin/xcrun",
        "--sdk",
        "macosx",
        "swiftc",
        "-parse-as-library",
        "-O",
        "-target",
        "arm64-apple-macos27.0",
        SOURCE,
        "-o",
        temporary,
      ],
      {
        input: "",
        baseEnv: nativeEnvironment(options.env),
        signal: options.signal,
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
        killProcessTree: true,
      },
    );
    options.signal?.throwIfAborted();
    if (result.code !== 0 || result.termination !== "exit") {
      throw new Error(
        `Could not build the Apple Foundation Models helper. Select Apple developer tools with the macOS 27 SDK and retry setup. ${result.stderr.toString("utf8").trim()}`,
      );
    }
  }

  /** Only selected setup publishes the helper used by ordinary inference. */
  async function prepareAppleFm(options: NativeOptions = {}): Promise<AppleFmFacts> {
    options.signal?.throwIfAborted();
    if (!supportsNativeModel()) {
      throw new Error(
        "Apple Foundation Models requires an Apple Silicon Mac running macOS 27 or later.",
      );
    }
    const command = await helperPath(options.env);
    if (!(await helperExists(command))) {
      await fs.mkdir(path.dirname(command), { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(path.dirname(command), "build-"));
      const temporary = path.join(directory, "helper");
      try {
        await compileHelper(temporary, options);
        await fs.chmod(temporary, 0o700);
        options.signal?.throwIfAborted();
        await fs.rename(temporary, command);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
    return infoSchema.parse(await invoke(command, ["info"], "", options));
  }

  async function runAppleFm(request: object, options: NativeOptions = {}): Promise<AppleFmResult> {
    if (!supportsNativeModel()) {
      throw new Error(
        "Apple Foundation Models is only available on Apple Silicon with macOS 27 or later.",
      );
    }
    const command = await helperPath(options.env);
    if (!(await helperExists(command))) {
      throw new Error(SETUP_REQUIRED);
    }
    return resultSchema.parse(await invoke(command, ["run"], JSON.stringify(request), options));
  }

  return { probe: probeAppleFm, prepare: prepareAppleFm, run: runAppleFm };
}

export type AppleFmNative = ReturnType<typeof createAppleFmNative>;
