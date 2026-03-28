import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const CLAWHUB_BASE = "https://clawhub.ai/api/v1";

type ClawHubSkill = {
  slug: string;
  displayName?: string;
  name?: string;
  summary?: string;
  description?: string;
  version?: string;
  downloads?: number;
  stars?: number;
  score?: number;
  tags?: string[];
  owner?: string;
};

export type BrowseSkill = {
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  stars: number;
  tags: string[];
};

function normalizeSkill(raw: ClawHubSkill): BrowseSkill {
  return {
    slug: raw.slug,
    // ClawHub search/list responses are not identical, so normalize them once here.
    displayName: raw.displayName ?? raw.name ?? raw.slug,
    summary: raw.summary ?? raw.description ?? "",
    version: raw.version ?? "",
    downloads: raw.downloads ?? 0,
    stars: raw.stars ?? 0,
    tags: raw.tags ?? [],
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const query = searchParams.get("q")?.trim();
  const limit = searchParams.get("limit") ?? "50";
  const sort = searchParams.get("sort") ?? "downloads";
  const cursor = searchParams.get("cursor");

  try {
    let url: string;
    if (query) {
      url = `${CLAWHUB_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    } else {
      url = `${CLAWHUB_BASE}/skills?limit=${limit}&sort=${sort}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      return Response.json(
        { skills: [], error: `ClawHub returned ${upstream.status}` },
        { status: 200 },
      );
    }

    const data = await upstream.json();

    let skills: BrowseSkill[];
    let nextCursor: string | null = null;

    if (query) {
      const results: ClawHubSkill[] = data.results ?? data.items ?? data.skills ?? [];
      skills = results.map(normalizeSkill);
    } else {
      const items: ClawHubSkill[] = data.items ?? data.skills ?? [];
      skills = items.map(normalizeSkill);
      nextCursor = data.nextCursor ?? null;
    }

    return Response.json({ skills, nextCursor });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ skills: [], error: message }, { status: 200 });
  }
}
