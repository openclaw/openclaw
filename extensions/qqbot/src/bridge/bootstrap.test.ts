// Qqbot tests cover the built-in platform adapter boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformAdapter } from "../engine/adapter/index.js";
import { QQBOT_MEDIA_FETCH_TIMEOUTS } from "../media-fetch-timeouts.js";
import { ensurePlatformAdapter } from "./bootstrap.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  readRemoteMediaBuffer: vi.fn(),
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  readRemoteMediaBuffer: (...args: unknown[]) => mocks.readRemoteMediaBuffer(...args),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: mocks.resolveApprovalOverGateway,
}));

const canonicalLoserResult = {
  applied: false,
  approval: {
    id: "exec:looks-like-exec/1",
    urlPath: "/approve/exec%3Alooks-like-exec%2F1",
    createdAtMs: 1,
    expiresAtMs: 10_000,
    presentation: {
      kind: "plugin",
      title: "Plugin approval",
      description: "Approve a plugin operation",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
    },
    status: "denied",
    decision: "deny",
    resolvedAtMs: 2,
    reason: "user",
  },
} satisfies ApprovalResolveResult;

describe("QQBot built-in platform adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ channels: { qqbot: {} } });
    mocks.resolveApprovalOverGateway.mockResolvedValue(canonicalLoserResult);
    ensurePlatformAdapter();
  });

  it("forwards response header deadlines to the media runtime", async () => {
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      fileName: "remote.png",
    });

    const result = await getPlatformAdapter().fetchMedia({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      maxBytes: 1024,
      maxRedirects: 2,
      timeoutMs: 5_000,
      ...QQBOT_MEDIA_FETCH_TIMEOUTS,
      ssrfPolicy: { hostnameAllowlist: ["*.qq.com"] },
      requestInit: { headers: { accept: "image/png" } },
    });

    expect(result).toEqual({ buffer: Buffer.from("image"), fileName: "remote.png" });
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledWith({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      maxBytes: 1024,
      maxRedirects: 2,
      timeoutMs: 5_000,
      ...QQBOT_MEDIA_FETCH_TIMEOUTS,
      ssrfPolicy: { hostnameAllowlist: ["*.qq.com"] },
      requestInit: { headers: { accept: "image/png" } },
    });
  });

  it("applies shared media timeouts when fetchMedia callers omit them", async () => {
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      fileName: "remote.png",
    });

    await getPlatformAdapter().fetchMedia({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
    });

    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledWith({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      maxBytes: undefined,
      maxRedirects: undefined,
      timeoutMs: undefined,
      ...QQBOT_MEDIA_FETCH_TIMEOUTS,
      ssrfPolicy: undefined,
      requestInit: undefined,
    });
  });

  it("applies header and idle timeouts on adapter downloadFile", async () => {
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      fileName: "remote.png",
    });
    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-bootstrap-download-"));

    try {
      const destPath = await getPlatformAdapter().downloadFile(
        "https://media.qq.com/assets/photo.png",
        destDir,
        "photo.png",
      );
      expect(destPath.endsWith("photo.png")).toBe(true);
      expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledWith({
        url: "https://media.qq.com/assets/photo.png",
        filePathHint: "photo.png",
        ...QQBOT_MEDIA_FETCH_TIMEOUTS,
      });
    } finally {
      await fs.rm(destDir, { recursive: true, force: true });
    }
  });

  it("preserves plugin ownership and the canonical first-answer result", async () => {
    const adapter = getPlatformAdapter();

    const result = await adapter.resolveApproval?.({
      approvalId: "exec:looks-like-exec/1",
      approvalKind: "plugin",
      decision: "allow-once",
    });

    expect(mocks.resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: { channels: { qqbot: {} } },
      approvalId: "exec:looks-like-exec/1",
      approvalKind: "plugin",
      decision: "allow-once",
      clientDisplayName: "QQBot Approval Handler",
    });
    expect(result).toBe(canonicalLoserResult);
  });
});
