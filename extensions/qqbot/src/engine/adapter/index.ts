/**
 * Platform adapter interface — abstracts framework-specific capabilities
 * so core/ modules remain portable between the built-in and standalone versions.
 *
 * Each version implements this interface in its own `bootstrap/adapter/` directory
 * and calls `registerPlatformAdapter()` during startup.
 *
 * core/ modules access platform capabilities via `getPlatformAdapter()`.
 */

import type { FetchMediaOptions, FetchMediaResult, SecretInputRef } from "./types.js";

/** Platform adapter that core/ modules use for framework-specific operations. */
export interface PlatformAdapter {
  /** Validate that a remote URL is safe to fetch (SSRF protection). */
  validateRemoteUrl(url: string, options?: { allowPrivate?: boolean }): Promise<void>;

  /** Resolve a secret value (SecretInput or plain string) to a plain string. */
  resolveSecret(value: string | SecretInputRef | undefined): Promise<string | undefined>;

  /** Download a remote file to a local directory. Returns the local file path. */
  downloadFile(url: string, destDir: string, filename?: string): Promise<string>;

  /**
   * Fetch remote media with SSRF protection.
   * Replaces direct usage of `fetchRemoteMedia` from `plugin-sdk/media-runtime`.
   */
  fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult>;

  /** Return the preferred temporary directory for the platform. */
  getTempDir(): string;

  /** Check whether a secret input value has been configured (non-empty). */
  hasConfiguredSecret(value: unknown): boolean;

  /**
   * Normalize a raw SecretInput value into a plain string.
   * For unresolved references (e.g. `$secret:xxx`), returns the raw reference string.
   */
  normalizeSecretInputString(value: unknown): string | undefined;

  /**
   * Resolve a SecretInput value into the final plain-text secret.
   * For secret references, resolves them to actual values via the platform's secret store.
   */
  resolveSecretInputString(params: { value: unknown; path: string }): string | undefined;
}

let _adapter: PlatformAdapter | null = null;

/** Register the platform adapter. Called once during startup. */
export function registerPlatformAdapter(adapter: PlatformAdapter): void {
  _adapter = adapter;
}

/** Get the registered platform adapter. Throws if not registered. */
export function getPlatformAdapter(): PlatformAdapter {
  if (!_adapter) {
    throw new Error(
      "PlatformAdapter not registered. Call registerPlatformAdapter() during bootstrap.",
    );
  }
  return _adapter;
}

/** Check whether a platform adapter has been registered. */
export function hasPlatformAdapter(): boolean {
  return _adapter !== null;
}
