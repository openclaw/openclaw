import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
const DEFAULT_TTL_MS = 30 * 60 * 1e3;
const MAX_TTL_MS = 6 * 60 * 60 * 1e3;
const SWEEP_FALLBACK_AGE_MS = 24 * 60 * 60 * 1e3;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1e3;
const VIEWER_PREFIX = "/plugins/diffs/view";
class DiffArtifactStore {
  constructor(params) {
    this.cleanupInFlight = null;
    this.nextCleanupAt = 0;
    this.rootDir = path.resolve(params.rootDir);
    this.logger = params.logger;
    this.cleanupIntervalMs = params.cleanupIntervalMs === void 0 ? DEFAULT_CLEANUP_INTERVAL_MS : Math.max(0, Math.floor(params.cleanupIntervalMs));
  }
  async createArtifact(params) {
    await this.ensureRoot();
    const id = crypto.randomBytes(10).toString("hex");
    const token = crypto.randomBytes(24).toString("hex");
    const artifactDir = this.artifactDir(id);
    const htmlPath = path.join(artifactDir, "viewer.html");
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const createdAt = /* @__PURE__ */ new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const meta = {
      id,
      token,
      title: params.title,
      inputKind: params.inputKind,
      fileCount: params.fileCount,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      viewerPath: `${VIEWER_PREFIX}/${id}/${token}`,
      htmlPath
    };
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(htmlPath, params.html, "utf8");
    await this.writeMeta(meta);
    this.scheduleCleanup();
    return meta;
  }
  async getArtifact(id, token) {
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
  async readHtml(id) {
    const meta = await this.readMeta(id);
    if (!meta) {
      throw new Error(`Diff artifact not found: ${id}`);
    }
    const htmlPath = this.normalizeStoredPath(meta.htmlPath, "htmlPath");
    return await fs.readFile(htmlPath, "utf8");
  }
  async updateFilePath(id, filePath) {
    const meta = await this.readMeta(id);
    if (!meta) {
      throw new Error(`Diff artifact not found: ${id}`);
    }
    const normalizedFilePath = this.normalizeStoredPath(filePath, "filePath");
    const next = {
      ...meta,
      filePath: normalizedFilePath,
      imagePath: normalizedFilePath
    };
    await this.writeMeta(next);
    return next;
  }
  async updateImagePath(id, imagePath) {
    return this.updateFilePath(id, imagePath);
  }
  allocateFilePath(id, format = "png") {
    return path.join(this.artifactDir(id), `preview.${format}`);
  }
  async createStandaloneFileArtifact(params = {}) {
    await this.ensureRoot();
    const id = crypto.randomBytes(10).toString("hex");
    const artifactDir = this.artifactDir(id);
    const format = params.format ?? "png";
    const filePath = path.join(artifactDir, `preview.${format}`);
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const createdAt = /* @__PURE__ */ new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
    const meta = {
      kind: "standalone_file",
      id,
      createdAt: createdAt.toISOString(),
      expiresAt,
      filePath: this.normalizeStoredPath(filePath, "filePath")
    };
    await fs.mkdir(artifactDir, { recursive: true });
    await this.writeStandaloneMeta(meta);
    this.scheduleCleanup();
    return {
      id,
      filePath: meta.filePath,
      expiresAt: meta.expiresAt
    };
  }
  allocateImagePath(id, format = "png") {
    return this.allocateFilePath(id, format);
  }
  scheduleCleanup() {
    this.maybeCleanupExpired();
  }
  async cleanupExpired() {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const id = entry.name;
        const meta = await this.readMeta(id);
        if (meta) {
          if (isExpired(meta)) {
            await this.deleteArtifact(id);
          }
          return;
        }
        const standaloneMeta = await this.readStandaloneMeta(id);
        if (standaloneMeta) {
          if (isExpired(standaloneMeta)) {
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
      })
    );
  }
  async ensureRoot() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }
  maybeCleanupExpired() {
    const now = Date.now();
    if (this.cleanupInFlight || now < this.nextCleanupAt) {
      return;
    }
    this.nextCleanupAt = now + this.cleanupIntervalMs;
    const cleanupPromise = this.cleanupExpired().catch((error) => {
      this.nextCleanupAt = 0;
      this.logger?.warn(`Failed to clean expired diff artifacts: ${String(error)}`);
    }).finally(() => {
      if (this.cleanupInFlight === cleanupPromise) {
        this.cleanupInFlight = null;
      }
    });
    this.cleanupInFlight = cleanupPromise;
  }
  artifactDir(id) {
    return this.resolveWithinRoot(id);
  }
  async writeMeta(meta) {
    await this.writeJsonMeta(meta.id, "meta.json", meta);
  }
  async readMeta(id) {
    const parsed = await this.readJsonMeta(id, "meta.json", "diff artifact");
    if (!parsed) {
      return null;
    }
    return parsed;
  }
  async writeStandaloneMeta(meta) {
    await this.writeJsonMeta(meta.id, "file-meta.json", meta);
  }
  async readStandaloneMeta(id) {
    const parsed = await this.readJsonMeta(id, "file-meta.json", "standalone diff");
    if (!parsed) {
      return null;
    }
    try {
      const value = parsed;
      if (value.kind !== "standalone_file" || typeof value.id !== "string" || typeof value.createdAt !== "string" || typeof value.expiresAt !== "string" || typeof value.filePath !== "string") {
        return null;
      }
      return {
        kind: value.kind,
        id: value.id,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        filePath: this.normalizeStoredPath(value.filePath, "filePath")
      };
    } catch (error) {
      this.logger?.warn(`Failed to normalize standalone diff metadata for ${id}: ${String(error)}`);
      return null;
    }
  }
  metaFilePath(id, fileName) {
    return path.join(this.artifactDir(id), fileName);
  }
  async writeJsonMeta(id, fileName, data) {
    await fs.writeFile(this.metaFilePath(id, fileName), JSON.stringify(data, null, 2), "utf8");
  }
  async readJsonMeta(id, fileName, context) {
    try {
      const raw = await fs.readFile(this.metaFilePath(id, fileName), "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      this.logger?.warn(`Failed to read ${context} metadata for ${id}: ${String(error)}`);
      return null;
    }
  }
  async deleteArtifact(id) {
    await fs.rm(this.artifactDir(id), { recursive: true, force: true }).catch(() => {
    });
  }
  resolveWithinRoot(...parts) {
    const candidate = path.resolve(this.rootDir, ...parts);
    this.assertWithinRoot(candidate);
    return candidate;
  }
  normalizeStoredPath(rawPath, label) {
    const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(this.rootDir, rawPath);
    this.assertWithinRoot(candidate, label);
    return candidate;
  }
  assertWithinRoot(candidate, label = "path") {
    const relative = path.relative(this.rootDir, candidate);
    if (relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
      return;
    }
    throw new Error(`Diff artifact ${label} escapes store root: ${candidate}`);
  }
}
function normalizeTtlMs(value) {
  if (!Number.isFinite(value) || value === void 0) {
    return DEFAULT_TTL_MS;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(rounded, MAX_TTL_MS);
}
function isExpired(meta) {
  const expiresAt = Date.parse(meta.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return Date.now() >= expiresAt;
}
function isFileNotFound(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export {
  DiffArtifactStore
};
