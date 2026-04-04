import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const SKILLS_SH_SEARCH_URL = "https://skills.sh/api/search";
const DEFAULT_BROWSE_QUERIES = ["nextjs", "react", "browser"];

const CATEGORY_MAP: Record<string, string> = {
  React: "react",
  "Next.js": "nextjs",
  AI: "ai",
  Python: "python",
  TypeScript: "typescript",
  DevOps: "docker",
  Testing: "testing",
  Databases: "database",
};

const CATEGORIES = Object.keys(CATEGORY_MAP);

const FEATURED_QUERIES = ["react", "ai", "nextjs", "typescript", "python", "docker"];
const FEATURED_LIMIT = 15;

type SkillsShSkill = {
  id: string;
  skillId?: string;
  name?: string;
  installs?: number;
  source?: string;
};

export type BrowseSkill = {
  slug: string;
  displayName: string;
  summary: string;
  installs: number;
  source: string;
};

function humanizeSlug(slug: string): string {
  return slug
    .replace(/^(vercel|cursor|claude)-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function generateSummary(slug: string, source: string): string {
  const org = source.split("/")[0] ?? source;
  const label = humanizeSlug(slug);
  return `${label} skill by ${org}`;
}

function normalizeSkill(raw: SkillsShSkill): BrowseSkill {
  const slug = raw.skillId ?? raw.name ?? raw.id.split("/").at(-1) ?? raw.id;
  const source = raw.source ?? raw.id.split("/").slice(0, 2).join("/");

  return {
    slug,
    displayName: raw.name ?? slug,
    summary: generateSummary(slug, source),
    installs: raw.installs ?? 0,
    source,
  };
}

async function fetchSkills(query: string, limit: string): Promise<Response> {
  const url = `${SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`;
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
}

async function fetchAndNormalize(query: string, limit: string): Promise<BrowseSkill[]> {
  const upstream = await fetchSkills(query, limit);
  if (!upstream.ok) return [];
  const data = await upstream.json();
  const results: SkillsShSkill[] = Array.isArray(data.skills) ? data.skills : [];
  return results
    .map(normalizeSkill)
    .filter((skill) => Boolean(skill.slug) && Boolean(skill.source));
}

function dedupeBySlug(skills: BrowseSkill[]): BrowseSkill[] {
  const seen = new Set<string>();
  const unique: BrowseSkill[] = [];
  for (const skill of skills) {
    if (!seen.has(skill.slug)) {
      seen.add(skill.slug);
      unique.push(skill);
    }
  }
  return unique;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const query = searchParams.get("q")?.trim();
  const category = searchParams.get("category")?.trim();
  const featured = searchParams.get("featured") === "true";
  const limit = searchParams.get("limit") ?? "50";

  try {
    if (featured) {
      const batches = await Promise.allSettled(
        FEATURED_QUERIES.map((q) => fetchAndNormalize(q, String(FEATURED_LIMIT))),
      );
      const all = batches.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const skills = dedupeBySlug(all).sort((a, b) => b.installs - a.installs);
      return Response.json({ skills, categories: CATEGORIES });
    }

    const effectiveQuery = category && !query
      ? CATEGORY_MAP[category] ?? category.toLowerCase()
      : query;

    const browseQueries = effectiveQuery ? [effectiveQuery] : DEFAULT_BROWSE_QUERIES;
    let lastError: string | null = null;

    for (const browseQuery of browseQueries) {
      try {
        const skills = await fetchAndNormalize(browseQuery, limit);

        if (skills.length > 0 || effectiveQuery) {
          return Response.json({ skills, categories: CATEGORIES });
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (effectiveQuery) {
          break;
        }
      }
    }

    return Response.json({ skills: [], categories: CATEGORIES, error: lastError ?? "No skills found" }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ skills: [], categories: CATEGORIES, error: message }, { status: 200 });
  }
}
