import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk/executorch";
import {
  loadNativeExecuTorchAddon,
  type NativeExecuTorchAddon,
  type NativeRunnerCreateConfig,
  type RunnerBackend,
} from "./native-addon.js";
import { ensureRuntimeLibraryLoadable } from "./runtime-library.js";

export type RunnerState = "unloaded" | "loading" | "ready" | "error";

type RunnerManagerOptions = {
  runtimeLibraryPath: string;
  backend: RunnerBackend;
  modelPath: string;
  tokenizerPath: string;
  dataPath?: string;
  logger: PluginLogger;
  warmup?: boolean;
};

/**
 * Manages an embedded Parakeet runtime loaded from a native library.
 *
 * This replaces the previous subprocess approach and runs inference in-process
 * through the ExecuTorch C API bridge.
 */
export class RunnerManager {
  private handle: object | null = null;
  private _state: RunnerState = "unloaded";
  private readyPromise: Promise<void> | null = null;
  private _native: NativeExecuTorchAddon | null = null;

  private get native(): NativeExecuTorchAddon {
    if (!this._native) this._native = loadNativeExecuTorchAddon();
    return this._native;
  }

  private readonly runtimeLibraryPath: string;
  private readonly backend: RunnerBackend;
  private modelPath: string;
  private tokenizerPath: string;
  private dataPath: string | undefined;
  private readonly logger: PluginLogger;
  private readonly warmup: boolean;

  constructor(options: RunnerManagerOptions) {
    this.runtimeLibraryPath = options.runtimeLibraryPath;
    this.backend = options.backend;
    this.modelPath = options.modelPath;
    this.tokenizerPath = options.tokenizerPath;
    this.dataPath = options.dataPath;
    this.logger = options.logger;
    this.warmup = options.warmup ?? true;
  }

  get state(): RunnerState {
    return this._state;
  }

  get isAlive(): boolean {
    return this.handle !== null;
  }

  async ensureReady(): Promise<void> {
    if (this._state === "ready" && this.isAlive) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.launch();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  async transcribe(pcmBuffer: Buffer): Promise<string> {
    await this.ensureReady();
    if (!this.handle) {
      throw new Error("Runtime handle is not initialized");
    }
    try {
      const text = this.native.transcribe(this.handle, pcmBuffer, {
        maxNewTokens: 500,
        temperature: 0.0,
      });
      return text.trim();
    } catch (error) {
      this._state = "error";
      throw error;
    }
  }

  stop(): void {
    if (this.handle) {
      try {
        this.native.destroyRunner(this.handle);
      } catch {
        // already released
      }
      this.handle = null;
    }
    this._state = "unloaded";
    this.readyPromise = null;
  }

  private async launch(): Promise<void> {
    this.stop();

    await this.validatePaths();
    await ensureRuntimeLibraryLoadable(this.runtimeLibraryPath, this.logger);

    this._state = "loading";
    this.logger.info(
      `[executorch] Loading embedded runtime (backend=${this.backend}, library=${this.runtimeLibraryPath})`,
    );

    const config: NativeRunnerCreateConfig = {
      runtimeLibraryPath: this.runtimeLibraryPath,
      backend: this.backend,
      modelPath: this.modelPath,
      tokenizerPath: this.tokenizerPath,
      warmup: this.warmup,
    };
    if (this.dataPath) {
      config.dataPath = this.dataPath;
    }

    try {
      this.handle = this.native.createRunner(config);
      this._state = "ready";
      this.logger.info("[executorch] Model loaded — embedded runtime ready");
    } catch (error) {
      this._state = "error";
      this.handle = null;
      throw error;
    }
  }

  private async validatePaths(): Promise<void> {
    const missing: string[] = [];
    const required = [this.runtimeLibraryPath];

    const modelCandidates = this.modelFileCandidates();
    const resolvedModelPath = await this.resolveFirstExisting(modelCandidates);
    if (!resolvedModelPath) {
      missing.push(modelCandidates.join(" or "));
    } else {
      this.modelPath = resolvedModelPath;
      required.push(this.modelPath);
    }

    const tokenizerCandidates = this.tokenizerFileCandidates(resolvedModelPath ?? this.modelPath);
    const resolvedTokenizerPath = await this.resolveFirstExisting(tokenizerCandidates);
    if (!resolvedTokenizerPath) {
      missing.push(tokenizerCandidates.join(" or "));
    } else {
      this.tokenizerPath = resolvedTokenizerPath;
      required.push(this.tokenizerPath);
    }

    if (this.dataPath) {
      required.push(this.dataPath);
    }

    for (const p of required) {
      try {
        await fs.access(p);
      } catch {
        missing.push(p);
      }
    }

    if (missing.length > 0) {
      const uniqueMissing = [...new Set(missing)];
      throw new Error(`ExecuTorch files not found: ${uniqueMissing.join(", ")}`);
    }
  }

  private async resolveFirstExisting(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
    return null;
  }

  private modelFileCandidates(): string[] {
    const modelDir = path.dirname(this.modelPath);
    const candidates = [
      this.modelPath,
      path.join(modelDir, "model.pte"),
      path.join(modelDir, "parakeet.pte"),
    ];
    return [...new Set(candidates)];
  }

  private tokenizerFileCandidates(resolvedModelPath: string): string[] {
    const tokenizerDir = path.dirname(this.tokenizerPath);
    const modelDir = path.dirname(resolvedModelPath);
    const preferredNames = ["tokenizer.model", "tokenizer.json"];
    const candidates = [
      this.tokenizerPath,
      ...preferredNames.map((name) => path.join(tokenizerDir, name)),
      ...preferredNames.map((name) => path.join(modelDir, name)),
    ];
    return [...new Set(candidates)];
  }
}
