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
  modelFileCandidates?: readonly string[];
  tokenizerPath: string;
  tokenizerFileCandidates?: readonly string[];
  dataPath?: string;
  logger: PluginLogger;
  warmup?: boolean;
};

/**
 * Manages an embedded ExecuTorch runtime loaded from a native library.
 *
 * The manager is model-plugin agnostic: callers provide model/tokenizer
 * fallback file names so additional model plugins can reuse the same lifecycle.
 */
export class RunnerManager {
  private handle: object | null = null;
  private _state: RunnerState = "unloaded";
  private readyPromise: Promise<void> | null = null;
  private _native: NativeExecuTorchAddon | null = null;
  private launchGeneration = 0;
  /** Incremented only from `stop()` so waiters can avoid auto-relaunch after cancellation. */
  private stopEpoch = 0;

  private get native(): NativeExecuTorchAddon {
    if (!this._native) this._native = loadNativeExecuTorchAddon();
    return this._native;
  }

  private readonly runtimeLibraryPath: string;
  private readonly backend: RunnerBackend;
  private modelPath: string;
  private readonly fallbackModelFileNames: string[];
  private tokenizerPath: string;
  private readonly fallbackTokenizerFileNames: string[];
  private dataPath: string | undefined;
  private readonly logger: PluginLogger;
  private readonly warmup: boolean;

  constructor(options: RunnerManagerOptions) {
    this.runtimeLibraryPath = options.runtimeLibraryPath;
    this.backend = options.backend;
    this.modelPath = options.modelPath;
    this.fallbackModelFileNames = this.normalizeFallbackNames(options.modelFileCandidates, [
      "model.pte",
      "parakeet.pte",
    ]);
    this.tokenizerPath = options.tokenizerPath;
    this.fallbackTokenizerFileNames = this.normalizeFallbackNames(options.tokenizerFileCandidates, [
      "tokenizer.model",
      "tokenizer.json",
    ]);
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
    const stopEpochAtEntry = this.stopEpoch;
    for (;;) {
      if (this._state === "ready" && this.isAlive) {
        return;
      }
      if (this.readyPromise) {
        const pending = this.readyPromise;
        await pending;
        if (this._state === "ready" && this.isAlive) {
          return;
        }
        // Shared launch finished without a live handle: retry unless `stop()` ran during the wait
        // (callers awaiting the same promise after stop should observe unloaded, not cold-load again).
        if (this.stopEpoch > stopEpochAtEntry) {
          return;
        }
        continue;
      }
      const launchPromise = this.launch();
      this.readyPromise = launchPromise;
      try {
        await launchPromise;
      } finally {
        if (this.readyPromise === launchPromise) {
          this.readyPromise = null;
        }
      }
      if (this._state === "ready" && this.isAlive) {
        return;
      }
      if (this.stopEpoch > stopEpochAtEntry) {
        return;
      }
    }
  }

  async transcribe(pcmBuffer: Buffer): Promise<string> {
    await this.ensureReady();
    if (!this.handle) {
      throw new Error("Runtime handle is not initialized");
    }
    try {
      const text = await this.native.transcribe(this.handle, pcmBuffer, {
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
    this.stopEpoch += 1;
    this.launchGeneration += 1;
    this.resetHandle();
  }

  private async launch(): Promise<void> {
    const launchGeneration = this.launchGeneration + 1;
    this.launchGeneration = launchGeneration;
    this.resetHandle();

    await this.validatePaths();
    if (!this.isActiveLaunch(launchGeneration)) {
      return;
    }
    await ensureRuntimeLibraryLoadable(this.runtimeLibraryPath, this.logger);
    if (!this.isActiveLaunch(launchGeneration)) {
      return;
    }

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
      const handle = await this.native.createRunner(config);
      if (!this.isActiveLaunch(launchGeneration)) {
        this.destroyHandle(handle);
        return;
      }
      this.handle = handle;
      this._state = "ready";
      this.logger.info("[executorch] Model loaded — embedded runtime ready");
    } catch (error) {
      if (!this.isActiveLaunch(launchGeneration)) {
        return;
      }
      this._state = "error";
      this.handle = null;
      throw error;
    }
  }

  private isActiveLaunch(launchGeneration: number): boolean {
    return this.launchGeneration === launchGeneration;
  }

  private resetHandle(): void {
    this.destroyHandle(this.handle);
    this.handle = null;
    this._state = "unloaded";
  }

  private destroyHandle(handle: object | null): void {
    if (!handle) {
      return;
    }
    try {
      this.native.destroyRunner(handle);
    } catch {
      // already released
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
    }

    const tokenizerCandidates = this.tokenizerFileCandidates(resolvedModelPath ?? this.modelPath);
    const resolvedTokenizerPath = await this.resolveFirstExisting(tokenizerCandidates);
    if (!resolvedTokenizerPath) {
      missing.push(tokenizerCandidates.join(" or "));
    } else {
      this.tokenizerPath = resolvedTokenizerPath;
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
      ...this.fallbackModelFileNames.map((name) => path.join(modelDir, name)),
    ];
    return [...new Set(candidates)];
  }

  private tokenizerFileCandidates(resolvedModelPath: string): string[] {
    const tokenizerDir = path.dirname(this.tokenizerPath);
    const modelDir = path.dirname(resolvedModelPath);
    const candidates = [
      this.tokenizerPath,
      ...this.fallbackTokenizerFileNames.map((name) => path.join(tokenizerDir, name)),
      ...this.fallbackTokenizerFileNames.map((name) => path.join(modelDir, name)),
    ];
    return [...new Set(candidates)];
  }

  private normalizeFallbackNames(
    candidates: readonly string[] | undefined,
    defaults: string[],
  ): string[] {
    const picked = (candidates ?? defaults).map((entry) => entry.trim()).filter(Boolean);
    if (picked.length === 0) {
      return defaults;
    }
    return [...new Set(picked)];
  }
}
