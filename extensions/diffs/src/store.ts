import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { DiffArtifactMeta } from "./types.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_FALLBACK_AGE_MS = 24 * 60 * 60 * 1000;
const VIEWER_PREFIX = "/plugins/diffs/view";

type CreateArtifactParams = {
  html: string;
  title: string;
  inputKind: DiffArtifactMeta["inputKind"];
  fileCount: number;
  ttlMs?: number;
};

export class DiffArtifactStore {
  private readonly rootDir: string;
  private readonly logger?: PluginLogger;

  constructor(params: { rootDir: string; logger?: PluginLogger }) {
    this.rootDir = params.rootDir;
    this.logger = params.logger;
  }

  async createArtifact(params: CreateArtifactParams): Promise<DiffArtifactMeta> {
    await this.ensureRoot();
    await this.cleanupExpired();

    const id = crypto.randomBytes(10).toString("hex");
    const token = crypto.randomBytes(24).toString("hex");
    const artifactDir = this.artifactDir(id);
    const htmlPath = path.join(artifactDir, "viewer.html");
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const meta: DiffArtifactMeta = {
      id,
      token,
      title: params.title,
      inputKind: params.inputKind,
      fileCount: params.fileCount,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      viewerPath: `${VIEWER_PREFIX}/${id}/${token}`,
      htmlPath,
    };

    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(htmlPath, params.html, "utf8");
    await this.writeMeta(meta);
    return meta;
  }

  async getArtifact(id: string, token: string): Promise<DiffArtifactMeta | null> {
    const meta = await this.readMeta(id);
    if (!meta) {
      return null;
    }
    if (meta.token !== token) {
      return null;
    }
    if (isExpired(meta)) {
      await this.deleteArtifact(id);
      return null;
    }
    return meta;
  }

  async readHtml(id: string): Promise<string> {
    const meta = await this.readMeta(id);
    if (!meta) {
      throw new Error(`Diff artifact not found: ${id}`);
    }
    return await fs.readFile(meta.htmlPath, "utf8");
  }

  async updateImagePath(id: string, imagePath: string): Promise<DiffArtifactMeta> {
    const meta = await this.readMeta(id);
    if (!meta) {
      throw new Error(`Diff artifact not found: ${id}`);
    }
    const next: DiffArtifactMeta = {
      ...meta,
      imagePath,
    };
    await this.writeMeta(next);
    return next;
  }

  allocateImagePath(id: string): string {
    return path.join(this.artifactDir(id), "preview.png");
  }

  async cleanupExpired(): Promise<void> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const id = entry.name;
          const meta = await this.readMeta(id);
          if (meta) {
            if (isExpired(meta)) {
              await this.deleteArtifact(id);
            }
            return;
          }

          const artifactPath = this.artifactDir(id);
          const stat = await fs.stat(artifactPath).catch(() => null);
          if (!stat) {
            return;
          }
          if (now - stat.mtimeMs > SWEEP_FALLBACK_AGE_MS) {
            await this.deleteArtifact(id);
          }
        }),
    );
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  private artifactDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  private metaPath(id: string): string {
    return path.join(this.artifactDir(id), "meta.json");
  }

  private async writeMeta(meta: DiffArtifactMeta): Promise<void> {
    await fs.writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2), "utf8");
  }

  private async readMeta(id: string): Promise<DiffArtifactMeta | null> {
    try {
      const raw = await fs.readFile(this.metaPath(id), "utf8");
      return JSON.parse(raw) as DiffArtifactMeta;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      this.logger?.warn(`Failed to read diff artifact metadata for ${id}: ${String(error)}`);
      return null;
    }
  }

  private async deleteArtifact(id: string): Promise<void> {
    await fs.rm(this.artifactDir(id), { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeTtlMs(value?: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_TTL_MS;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(rounded, MAX_TTL_MS);
}

function isExpired(meta: DiffArtifactMeta): boolean {
  const expiresAt = Date.parse(meta.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return Date.now() >= expiresAt;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
