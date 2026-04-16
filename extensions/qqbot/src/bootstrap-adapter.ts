/**
 * Bootstrap the PlatformAdapter for the built-in version.
 *
 * This file is imported as a side-effect by channel.ts to ensure the adapter
 * is registered before any core/ module calls `getPlatformAdapter()`.
 *
 * The adapter bridges plugin-sdk platform capabilities into the core/ interface.
 */

import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { fetchRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { registerPlatformAdapter, type PlatformAdapter } from "./engine/adapter/index.js";
import type { FetchMediaOptions, FetchMediaResult } from "./engine/adapter/types.js";

const builtinAdapter: PlatformAdapter = {
  async validateRemoteUrl(_url: string, _options?: { allowPrivate?: boolean }): Promise<void> {
    // Built-in version delegates SSRF validation to fetchRemoteMedia's ssrfPolicy.
    // No separate validation step needed.
  },

  async resolveSecret(value): Promise<string | undefined> {
    if (typeof value === "string") {
      return value || undefined;
    }
    return undefined;
  },

  async downloadFile(url: string, destDir: string, filename?: string): Promise<string> {
    const result = await fetchRemoteMedia({ url, filePathHint: filename });
    const fs = await import("node:fs");
    const path = await import("node:path");
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const destPath = path.join(destDir, filename ?? "download");
    fs.writeFileSync(destPath, result.buffer);
    return destPath;
  },

  async fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
    const result = await fetchRemoteMedia({
      url: options.url,
      filePathHint: options.filePathHint,
      maxBytes: options.maxBytes,
      maxRedirects: options.maxRedirects,
      ssrfPolicy: options.ssrfPolicy,
      requestInit: options.requestInit,
    });
    return { buffer: result.buffer, fileName: result.fileName };
  },

  getTempDir(): string {
    return resolvePreferredOpenClawTmpDir();
  },

  hasConfiguredSecret(value: unknown): boolean {
    return hasConfiguredSecretInput(value);
  },

  normalizeSecretInputString(value: unknown): string | undefined {
    return normalizeSecretInputString(value) ?? undefined;
  },

  resolveSecretInputString(params: { value: unknown; path: string }): string | undefined {
    return normalizeResolvedSecretInputString(params) ?? undefined;
  },

  async resolveApproval(approvalId: string, decision: string): Promise<boolean> {
    try {
      const { loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
      const cfg = loadConfig();
      await resolveApprovalOverGateway({
        cfg,
        approvalId,
        decision: decision as "allow-once" | "allow-always" | "deny",
        clientDisplayName: "QQBot Approval Handler",
      });
      return true;
    } catch (err) {
      console.error(`[qqbot] resolveApproval failed: ${String(err)}`);
      return false;
    }
  },
};

registerPlatformAdapter(builtinAdapter);
