import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const SKILLS_SH_SEARCH_URL = "https://skills.sh/api/search";
const DEFAULT_BROWSE_QUERIES = ["nextjs", "react", "browser"];

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

function normalizeSkill(raw: SkillsShSkill): BrowseSkill {
  const slug = raw.skillId ?? raw.name ?? raw.id.split("/").at(-1) ?? raw.id;
  const source = raw.source ?? raw.id.split("/").slice(0, 2).join("/");

  return {
    slug,
    displayName: raw.name ?? slug,
    summary: source ? `by ${source}` : "",
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

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const query = searchParams.get("q")?.trim();
  const limit = searchParams.get("limit") ?? "50";

  try {
    const browseQueries = query ? [query] : DEFAULT_BROWSE_QUERIES;
    let lastError: string | null = null;

    for (const browseQuery of browseQueries) {
      try {
        const upstream = await fetchSkills(browseQuery, limit);

        if (!upstream.ok) {
          lastError = `skills.sh returned ${upstream.status}`;
          continue;
        }

        const data = await upstream.json();
        const results: SkillsShSkill[] = Array.isArray(data.skills) ? data.skills : [];
        const skills = results
          .map(normalizeSkill)
          .filter((skill) => Boolean(skill.slug) && Boolean(skill.source));

        if (skills.length > 0 || query) {
          return Response.json({ skills });
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (query) {
          break;
        }
      }
    }

    return Response.json({ skills: [], error: lastError ?? "No skills found" }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ skills: [], error: message }, { status: 200 });
  }
}
