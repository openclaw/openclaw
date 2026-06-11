import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  redactControlUiSmokeSecrets,
  resolveControlUiSmokeUrl,
  type ControlUiSmokeUrl,
} from "./control-ui-smoke-url.js";

const FRESHNESS_QUERY = "__openclaw_sw_update";

export type ControlUiFreshnessAuth = {
  token?: string | undefined;
  password?: string | undefined;
};

export type ControlUiFreshnessFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type ControlUiFreshnessResponse = ControlUiFreshnessFile & {
  url: string;
  status: number;
  cacheControl: string | null;
};

export type ControlUiFreshnessSummary = {
  ok: boolean;
  url: string;
  auth: ControlUiSmokeUrl["auth"];
  localRoot: string;
  checks: string[];
  local: Record<string, ControlUiFreshnessFile>;
  live: Record<string, ControlUiFreshnessResponse>;
  assetRefs: {
    local: string[];
    live: string[];
  };
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizePathKey(pathname: string): string {
  return pathname.replace(/^\/+/, "") || "index.html";
}

export function extractControlUiAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const pattern = /\b(?:src|href)=["']([^"']*assets\/[^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    const assetIndex = raw.indexOf("assets/");
    refs.add(assetIndex >= 0 ? raw.slice(assetIndex) : raw);
  }
  return [...refs].toSorted();
}

function hashParamsFor(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

export function extractControlUiFreshnessAuth(launchUrl: string): ControlUiFreshnessAuth {
  const url = new URL(launchUrl);
  const query = url.searchParams;
  const hash = hashParamsFor(url);
  return {
    token: query.get("token") ?? hash.get("token") ?? undefined,
    password: query.get("password") ?? hash.get("password") ?? undefined,
  };
}

export function resolveControlUiFreshnessUrl(input: {
  dashboardUrl: string;
  relativePath?: string;
  cacheBust?: string | number;
}): string {
  const base = new URL(input.dashboardUrl);
  const relativePath = input.relativePath ?? "./";
  const resolved = new URL(relativePath, base);
  resolved.hash = "";
  resolved.searchParams.set(FRESHNESS_QUERY, String(input.cacheBust ?? Date.now()));
  return resolved.toString();
}

function readLocalFile(
  localRoot: string,
  fileName: string,
): { text: string; meta: ControlUiFreshnessFile } {
  const filePath = resolve(localRoot, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Missing local Control UI freshness file: ${filePath}`);
  }
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`Local Control UI freshness path is not a file: ${filePath}`);
  }
  const text = readFileSync(filePath, "utf8");
  return {
    text,
    meta: {
      path: fileName,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text, "utf8"),
    },
  };
}

async function fetchText(params: {
  url: string;
  accept: string;
  auth?: ControlUiFreshnessAuth;
}): Promise<ControlUiFreshnessResponse & { text: string }> {
  const headers: Record<string, string> = {
    Accept: params.accept,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  const token = params.auth?.token ?? params.auth?.password;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: "GET",
      headers,
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch ${redactControlUiSmokeSecrets(params.url)}: ${message}`, {
      cause: error,
    });
  }
  const text = await response.text();
  return {
    url: redactControlUiSmokeSecrets(params.url),
    path: normalizePathKey(new URL(params.url).pathname),
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    text,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function assertLiveMatchesLocal(params: {
  fileName: string;
  local: ControlUiFreshnessFile;
  live: ControlUiFreshnessResponse;
}) {
  if (params.live.status !== 200) {
    throw new Error(`${params.fileName} returned HTTP ${params.live.status}.`);
  }
  if (params.local.sha256 !== params.live.sha256) {
    throw new Error(
      `${params.fileName} is stale: live sha256 ${params.live.sha256} does not match local sha256 ${params.local.sha256}.`,
    );
  }
}

function assertNoStoreHeader(params: { fileName: string; cacheControl: string | null }) {
  const normalized = params.cacheControl?.toLowerCase() ?? "";
  if (
    !normalized
      .split(",")
      .map((part) => part.trim())
      .includes("no-store")
  ) {
    throw new Error(
      `${params.fileName} must be served with Cache-Control: no-store; got ${params.cacheControl ?? "<missing>"}.`,
    );
  }
}

export async function runControlUiFreshnessSmoke(
  options: {
    localRoot?: string;
    smokeUrl?: ControlUiSmokeUrl;
    cacheBust?: string | number;
  } = {},
): Promise<ControlUiFreshnessSummary> {
  const smokeUrl =
    options.smokeUrl ??
    (await resolveControlUiSmokeUrl({
      explicitUrlEnvNames: ["OPENCLAW_CONTROL_UI_FRESHNESS_URL", "OPENCLAW_CONTROL_UI_SMOKE_URL"],
    }));
  const localRoot = resolve(
    options.localRoot ??
      process.env.OPENCLAW_CONTROL_UI_FRESHNESS_ROOT ??
      join("dist", "control-ui"),
  );
  const auth = extractControlUiFreshnessAuth(smokeUrl.launchUrl);
  const cacheBust = options.cacheBust ?? Date.now();
  const files = [
    { fileName: "index.html", relativePath: "./", accept: "text/html" },
    {
      fileName: "asset-manifest.json",
      relativePath: "./asset-manifest.json",
      accept: "application/json",
    },
    { fileName: "sw.js", relativePath: "./sw.js", accept: "application/javascript" },
  ] as const;

  const local: Record<string, ControlUiFreshnessFile> = {};
  const live: Record<string, ControlUiFreshnessResponse> = {};
  const checks: string[] = [];
  let localIndexHtml = "";
  let liveIndexHtml = "";

  for (const file of files) {
    const localFile = readLocalFile(localRoot, file.fileName);
    local[file.fileName] = localFile.meta;
    if (file.fileName === "index.html") {
      localIndexHtml = localFile.text;
    }
    const fetched = await fetchText({
      url: resolveControlUiFreshnessUrl({
        dashboardUrl: smokeUrl.displayUrl,
        relativePath: file.relativePath,
        cacheBust,
      }),
      accept: file.accept,
      auth,
    });
    const { text: liveText, ...liveMeta } = fetched;
    live[file.fileName] = liveMeta;
    if (file.fileName === "index.html") {
      liveIndexHtml = liveText;
      if (/Control UI assets not found|Cached app shell ready\s*$/.test(liveText)) {
        throw new Error("Live dashboard shell did not include the built Control UI app assets.");
      }
    }
    assertLiveMatchesLocal({ fileName: file.fileName, local: localFile.meta, live: liveMeta });
    assertNoStoreHeader({ fileName: file.fileName, cacheControl: liveMeta.cacheControl });
    checks.push(`${file.fileName}: live bytes and no-store header match local build`);
  }

  const localRefs = extractControlUiAssetRefs(localIndexHtml);
  const liveRefs = extractControlUiAssetRefs(liveIndexHtml);
  if (JSON.stringify(localRefs) !== JSON.stringify(liveRefs)) {
    throw new Error(
      `Live dashboard asset refs are stale: ${JSON.stringify(liveRefs)} does not match local ${JSON.stringify(localRefs)}.`,
    );
  }
  checks.push("index.html: hashed asset references match local dist/control-ui");

  return {
    ok: true,
    url: smokeUrl.displayUrl,
    auth: smokeUrl.auth,
    localRoot,
    checks,
    local,
    live,
    assetRefs: {
      local: localRefs,
      live: liveRefs,
    },
  };
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  runControlUiFreshnessSmoke()
    .then((summary) => {
      console.log("control-ui-freshness-smoke: ok", JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      const message = redactControlUiSmokeSecrets(
        error instanceof Error ? error.message : String(error),
      );
      console.error("control-ui-freshness-smoke: failed", message);
      process.exitCode = 1;
    });
}
