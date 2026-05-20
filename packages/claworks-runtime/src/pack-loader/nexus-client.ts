import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { extractPackBuffer } from "../interfaces/nexus/catalog.js";
import type { NexusPackageDetail, NexusPackageListResponse } from "../interfaces/nexus/types.js";

export type NexusInstallSpec = {
  slug: string;
  version?: string;
};

export function parseNexusSource(source: string): NexusInstallSpec | null {
  const raw = source.replace(/^nexus:\/\//, "").trim();
  if (!raw) {
    return null;
  }
  const [slug, version] = raw.split("@");
  if (!slug) {
    return null;
  }
  return { slug, version: version || undefined };
}

function normalizeRegistryUrl(registry: string): string {
  return registry.replace(/\/$/, "");
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nexus request failed ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function listNexusPackages(
  registry: string,
  opts?: { q?: string },
): Promise<NexusPackageListResponse> {
  const base = normalizeRegistryUrl(registry);
  const url = new URL(`${base}/api/packages`);
  url.searchParams.set("family", "claworks-pack");
  if (opts?.q) {
    url.searchParams.set("q", opts.q);
  }
  return await fetchJson<NexusPackageListResponse>(url.toString());
}

export async function getNexusPackage(registry: string, slug: string): Promise<NexusPackageDetail> {
  const base = normalizeRegistryUrl(registry);
  return await fetchJson<NexusPackageDetail>(`${base}/api/packages/${encodeURIComponent(slug)}`);
}

export async function downloadPackArtifact(
  registry: string,
  slug: string,
  version: string,
): Promise<Buffer> {
  const base = normalizeRegistryUrl(registry);
  const url = `${base}/api/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/artifacts/generic`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nexus artifact download failed ${res.status}: ${text}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

export async function installPackFromNexus(params: {
  registry: string;
  source: string;
  installRoot: string;
}): Promise<{ slug: string; version: string; path: string }> {
  const spec = parseNexusSource(params.source);
  if (!spec) {
    throw new Error(`Invalid nexus source: ${params.source}`);
  }

  let version = spec.version;
  if (!version) {
    const detail = await getNexusPackage(params.registry, spec.slug);
    version = detail.latestVersion ?? detail.versions[0];
  }
  if (!version) {
    throw new Error(`No version found for pack: ${spec.slug}`);
  }

  const archive = await downloadPackArtifact(params.registry, spec.slug, version);
  const destDir = join(params.installRoot, spec.slug);
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await extractPackBuffer(archive, destDir);

  return { slug: spec.slug, version, path: destDir };
}
