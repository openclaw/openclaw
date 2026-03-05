import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { collectRenderAssets } from "@/lib/render-assets";

export type AppMeta = {
  title: string;
  description: string;
  tags: string[];
  thumbnail: string;
  lastRendered: string | null;
  category: string;
};

export type ProjectCard = AppMeta & {
  appId: string;
  renderCount: number;
  latestRenderFile: string | null;
  latestRenderAt: string | null;
};

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

function toDisplayTitle(appId: string): string {
  return appId
    .split(/[/-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferCategoryFromAppId(appId: string): string {
  const normalized = appId.toLowerCase();
  if (normalized.includes("3d")) {
    return "3d";
  }
  if (normalized.includes("template")) {
    return "template";
  }
  if (normalized.includes("example")) {
    return "example";
  }
  if (normalized.includes("studio")) {
    return "tooling";
  }
  if (normalized.includes("mv")) {
    return "mv";
  }
  return "general";
}

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function isHiddenAppId(appId: string): boolean {
  return appId.split("/").some((segment) => segment.startsWith("."));
}

function isImagePath(value: string): boolean {
  return IMAGE_EXT_RE.test(value);
}

function isWithinPath(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function normalizeMeta(appId: string, input: unknown): AppMeta {
  const fallbackTitle = toDisplayTitle(appId);
  const fallback: AppMeta = {
    title: fallbackTitle,
    description: `${fallbackTitle} project`,
    tags: ["remotion"],
    thumbnail: "public/thumbnail.svg",
    lastRendered: null,
    category: "general",
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fallback;
  }

  const raw = input as Record<string, unknown>;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string")
    : fallback.tags;

  return {
    title:
      typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title.trim()
        : fallback.title,
    description:
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : fallback.description,
    tags: tags.length > 0 ? tags : fallback.tags,
    thumbnail:
      typeof raw.thumbnail === "string" && raw.thumbnail.trim().length > 0
        ? raw.thumbnail.trim()
        : fallback.thumbnail,
    lastRendered:
      typeof raw.lastRendered === "string" && raw.lastRendered.trim().length > 0
        ? raw.lastRendered.trim()
        : null,
    category:
      typeof raw.category === "string" && raw.category.trim().length > 0
        ? raw.category.trim()
        : fallback.category,
  };
}

function normalizeMetaFromPackageJson(appId: string, input: unknown): AppMeta {
  const base = normalizeMeta(appId, null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...base, category: inferCategoryFromAppId(appId) };
  }

  const raw = input as Record<string, unknown>;
  const pkgName =
    typeof raw.name === "string" && raw.name.trim().length > 0
      ? raw.name.replace(/^@studio\//, "").trim()
      : appId;
  const tags = sanitizeTags(raw.keywords);

  return {
    title: toDisplayTitle(pkgName),
    description:
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : base.description,
    tags: tags.length > 0 ? tags : base.tags,
    thumbnail: base.thumbnail,
    lastRendered: null,
    category: inferCategoryFromAppId(appId),
  };
}

async function findFirstImageFile(
  dir: string,
  depth = 0,
  maxDepth = 3,
): Promise<string | null> {
  if (depth > maxDepth) {
    return null;
  }

  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);

  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  for (const entry of sorted) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const nested = await findFirstImageFile(fullPath, depth + 1, maxDepth);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && isImagePath(entry.name)) {
      return fullPath;
    }
  }

  return null;
}

async function resolveThumbnailPath(
  appDir: string,
  requestedPath: string,
): Promise<string> {
  const candidates = [
    requestedPath,
    "public/thumbnail.png",
    "public/thumbnail.jpg",
    "public/thumbnail.jpeg",
    "public/thumbnail.webp",
    "public/thumbnail.avif",
    "public/thumbnail.svg",
    "public/assets/images/thumbnail.png",
    "public/assets/images/thumbnail.jpg",
    "public/assets/images/thumbnail.jpeg",
    "public/assets/images/thumbnail.webp",
    "public/assets/images/thumbnail.avif",
    "public/assets/images/thumbnail.svg",
  ].filter((item) => item && isImagePath(item));

  for (const candidate of candidates) {
    const fullPath = path.resolve(appDir, candidate);
    if (!isWithinPath(fullPath, appDir)) {
      continue;
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      continue;
    }
    return path.relative(appDir, fullPath).replaceAll(path.sep, "/");
  }

  const imageRoot = path.join(appDir, "public", "assets", "images");
  if (existsSync(imageRoot) && statSync(imageRoot).isDirectory()) {
    const found = await findFirstImageFile(imageRoot);
    if (found) {
      return path.relative(appDir, found).replaceAll(path.sep, "/");
    }
  }

  return "public/thumbnail.svg";
}

function toRenderedTime(value: string | null): number {
  if (!value) {
    return -1;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : -1;
}

export function resolveAppsRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "apps"),
    path.resolve(cwd, "..", "apps"),
    path.resolve(cwd, "..", "..", "apps"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error("Could not resolve workspace apps directory.");
}

async function collectMetaFiles(
  dir: string,
  depth = 0,
  maxDepth = 4,
): Promise<string[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        return collectMetaFiles(fullPath, depth + 1, maxDepth);
      }
      return entry.isFile() && entry.name === "app.meta.json" ? [fullPath] : [];
    }),
  );

  return nested.flat();
}

async function collectPackageFiles(
  dir: string,
  depth = 0,
  maxDepth = 4,
): Promise<string[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        return collectPackageFiles(fullPath, depth + 1, maxDepth);
      }
      return entry.isFile() && entry.name === "package.json" ? [fullPath] : [];
    }),
  );

  return nested.flat();
}

function looksLikeProjectDir(appDir: string): boolean {
  const checks = [
    "src",
    "app",
    "remotion.config.ts",
    "remotion.config.ts.disabled",
  ];
  return checks.some((entry) => existsSync(path.join(appDir, entry)));
}

function hasRenderAssetRoot(appDir: string): boolean {
  const candidates = [
    path.join(appDir, "out"),
    path.join(appDir, "public", "assets", "video"),
  ];
  return candidates.some(
    (candidate) => existsSync(candidate) && statSync(candidate).isDirectory(),
  );
}

async function collectProjectDirs(
  dir: string,
  depth = 0,
  maxDepth = 4,
): Promise<string[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return [];
      }

      if (SKIP_DIRS.has(entry.name)) {
        return [];
      }

      const fullPath = path.join(dir, entry.name);
      const children = await collectProjectDirs(fullPath, depth + 1, maxDepth);
      const current =
        looksLikeProjectDir(fullPath) || hasRenderAssetRoot(fullPath)
          ? [fullPath]
          : [];
      return [...current, ...children];
    }),
  );

  return nested.flat();
}

export async function collectProjects(): Promise<ProjectCard[]> {
  const appsRoot = resolveAppsRoot();
  const metaFiles = await collectMetaFiles(appsRoot);
  const projects = new Map<string, ProjectCard>();

  const metaProjects = await Promise.all(
    metaFiles.map(async (metaPath) => {
      try {
        const appId = path
          .relative(appsRoot, path.dirname(metaPath))
          .replaceAll(path.sep, "/");
        if (isHiddenAppId(appId)) {
          return null;
        }
        const text = await fs.readFile(metaPath, "utf8");
        const normalized = normalizeMeta(appId, JSON.parse(text));
        const thumbnail = await resolveThumbnailPath(
          path.dirname(metaPath),
          normalized.thumbnail,
        );
        const renders = await collectRenderAssets(path.dirname(metaPath), 200);
        const inferredLastRendered =
          normalized.lastRendered ??
          (renders[0] ? new Date(renders[0].mtimeMs).toISOString() : null);
        return {
          appId,
          ...normalized,
          lastRendered: inferredLastRendered,
          thumbnail,
          renderCount: renders.length,
          latestRenderFile: renders[0]?.relativePath ?? null,
          latestRenderAt: renders[0]
            ? new Date(renders[0].mtimeMs).toISOString()
            : null,
        } satisfies ProjectCard;
      } catch {
        return null;
      }
    }),
  );

  for (const project of metaProjects) {
    if (project) {
      projects.set(project.appId, project);
    }
  }

  const packageFiles = await collectPackageFiles(appsRoot);
  const packageProjects = await Promise.all(
    packageFiles.map(async (packagePath) => {
      try {
        const appDir = path.dirname(packagePath);
        const appId = path.relative(appsRoot, appDir).replaceAll(path.sep, "/");
        if (isHiddenAppId(appId) || !appId || projects.has(appId)) {
          return null;
        }
        if (!looksLikeProjectDir(appDir)) {
          return null;
        }
        const text = await fs.readFile(packagePath, "utf8");
        const normalized = normalizeMetaFromPackageJson(
          appId,
          JSON.parse(text),
        );
        const thumbnail = await resolveThumbnailPath(
          appDir,
          normalized.thumbnail,
        );
        const renders = await collectRenderAssets(appDir, 200);
        const inferredLastRendered =
          normalized.lastRendered ??
          (renders[0] ? new Date(renders[0].mtimeMs).toISOString() : null);
        return {
          appId,
          ...normalized,
          lastRendered: inferredLastRendered,
          thumbnail,
          renderCount: renders.length,
          latestRenderFile: renders[0]?.relativePath ?? null,
          latestRenderAt: renders[0]
            ? new Date(renders[0].mtimeMs).toISOString()
            : null,
        } satisfies ProjectCard;
      } catch {
        return null;
      }
    }),
  );

  for (const project of packageProjects) {
    if (project) {
      projects.set(project.appId, project);
    }
  }

  const projectDirs = await collectProjectDirs(appsRoot);
  const fallbackProjects = await Promise.all(
    projectDirs.map(async (appDir) => {
      try {
        const appId = path.relative(appsRoot, appDir).replaceAll(path.sep, "/");
        if (isHiddenAppId(appId) || !appId || projects.has(appId)) {
          return null;
        }

        const packagePath = path.join(appDir, "package.json");
        let packageJson: unknown = null;
        if (existsSync(packagePath) && statSync(packagePath).isFile()) {
          const packageText = await fs.readFile(packagePath, "utf8");
          packageJson = JSON.parse(packageText);
        }

        const normalized = normalizeMetaFromPackageJson(appId, packageJson);
        const thumbnail = await resolveThumbnailPath(
          appDir,
          normalized.thumbnail,
        );
        const renders = await collectRenderAssets(appDir, 200);
        const inferredLastRendered =
          normalized.lastRendered ??
          (renders[0] ? new Date(renders[0].mtimeMs).toISOString() : null);

        return {
          appId,
          ...normalized,
          lastRendered: inferredLastRendered,
          thumbnail,
          renderCount: renders.length,
          latestRenderFile: renders[0]?.relativePath ?? null,
          latestRenderAt: renders[0]
            ? new Date(renders[0].mtimeMs).toISOString()
            : null,
        } satisfies ProjectCard;
      } catch {
        return null;
      }
    }),
  );

  for (const project of fallbackProjects) {
    if (project) {
      projects.set(project.appId, project);
    }
  }

  return Array.from(projects.values()).sort(
    (a, b) => toRenderedTime(b.lastRendered) - toRenderedTime(a.lastRendered),
  );
}

export function formatLastRendered(value: string | null): string {
  if (!value) {
    return "未実行 / Never rendered";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function buildThumbnailUrl(project: ProjectCard): string {
  return `/api/thumbnail?app=${encodeURIComponent(project.appId)}&file=${encodeURIComponent(project.thumbnail)}`;
}
