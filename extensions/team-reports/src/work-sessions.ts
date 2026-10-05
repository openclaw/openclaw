import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { z } from "zod";
import { WORK_SESSIONS_PAGE_SIZE } from "./limits.js";
import type { Person } from "./types.js";

const workSessionSchema = z.object({
  key: z.string(),
  agentId: z.string().optional(),
  displayName: z.string().optional(),
  label: z.string().optional(),
  derivedTitle: z.string().optional(),
  owner: z
    .object({
      actor: z.object({
        type: z.enum(["human", "agent", "system"]),
        label: z.string().optional(),
      }),
    })
    .optional(),
  status: z.enum(["queued", "running", "done", "failed", "killed", "timeout"]).optional(),
  projectId: z.string().optional(),
  incognito: z.literal(true).optional(),
});
const workSessionsSchema = z.object({
  sessions: z.array(workSessionSchema),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
});

export type WorkSession = z.infer<typeof workSessionSchema>;
export type WorkSessions =
  | { available: true; sessions: WorkSession[]; nextOffset?: number }
  | { available: false };

/** Request-local projection only: never retain one viewer's sessions in the report store. */
export async function listWorkSessions(
  offset = 0,
  limit = WORK_SESSIONS_PAGE_SIZE,
  profileId?: string,
): Promise<WorkSessions> {
  try {
    const response = await dispatchGatewayMethod("sessions.list", {
      limit,
      offset,
      ...(profileId ? { profileRelation: { profileId, relationship: "owned" } } : {}),
      sortBy: "activity",
      archived: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: false,
    });
    const result = response.ok ? workSessionsSchema.safeParse(response.payload) : undefined;
    if (!result?.success) {
      return { available: false };
    }
    return {
      available: true,
      // Incognito rows never belong in a team activity view, even for their owner.
      sessions: result.data.sessions.filter((row) => !row.incognito),
      ...(result.data.hasMore && result.data.nextOffset != null
        ? { nextOffset: result.data.nextOffset }
        : {}),
    };
  } catch {
    // Session discovery must fail visibly without taking stored reports offline.
    return { available: false };
  }
}

const profilesSchema = z.object({
  profiles: z.array(
    z.object({
      id: z.string(),
      mergedInto: z.string().nullable(),
      githubIdentity: z.object({ login: z.string() }).nullable(),
    }),
  ),
});

type Profile = z.infer<typeof profilesSchema>["profiles"][number];
export type PersonWorkSessions =
  | WorkSessions
  | { available: false; reason: "unlinked" | "ambiguous" };

function resolveOwner(
  profiles: Profile[],
  aliases: string[],
): { profileId: string } | { reason: "unlinked" | "ambiguous" } {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const logins = new Set(aliases.map((alias) => alias.toLowerCase()));
  const owners = new Set<string>();
  for (const profile of profiles) {
    if (!profile.githubIdentity || !logins.has(profile.githubIdentity.login.toLowerCase())) {
      continue;
    }
    let canonical: Profile | undefined = profile;
    const visited = new Set<string>();
    while (canonical?.mergedInto) {
      if (visited.has(canonical.id)) {
        return { reason: "ambiguous" };
      }
      visited.add(canonical.id);
      canonical = byId.get(canonical.mergedInto);
    }
    // Never turn a broken merge reference into an unfiltered session query.
    if (!canonical) {
      return { reason: "ambiguous" };
    }
    owners.add(canonical.id);
  }
  const [profileId] = owners;
  return !profileId
    ? { reason: "unlinked" }
    : owners.size === 1
      ? { profileId }
      : { reason: "ambiguous" };
}

/** Instantiate once per HTTP request; identities and per-owner reads never cross viewers. */
export function createPersonWorkSessions(workSessions: typeof listWorkSessions) {
  let profiles: Promise<Profile[] | undefined> | undefined;
  const pages = new Map<string, Promise<WorkSessions>>();
  const loadProfiles = async () => {
    try {
      const response = await dispatchGatewayMethod("users.list", {});
      const result = response.ok ? profilesSchema.safeParse(response.payload) : undefined;
      return result?.success ? result.data.profiles : undefined;
    } catch {
      return undefined;
    }
  };
  return async (
    person: Pick<Person, "github">,
    offset = 0,
    limit = 3,
  ): Promise<PersonWorkSessions> => {
    const identities = await (profiles ??= loadProfiles());
    if (!identities) {
      return { available: false };
    }
    const owner = resolveOwner(identities, person.github);
    if ("reason" in owner) {
      return { available: false, reason: owner.reason };
    }
    const key = JSON.stringify([owner.profileId, offset, limit]);
    let page = pages.get(key);
    if (!page) {
      page = workSessions(offset, limit, owner.profileId);
      pages.set(key, page);
    }
    return page;
  };
}

/** Bound concurrent per-member dispatches; each owner needs only one small preview page. */
export async function listMemberWorkSessions(
  people: Person[],
  list: ReturnType<typeof createPersonWorkSessions>,
): Promise<ReadonlyMap<string, PersonWorkSessions>> {
  const result = new Map<string, PersonWorkSessions>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, people.length) }, async () => {
      for (let index = next++; index < people.length; index = next++) {
        const person = people[index]!;
        result.set((person.github[0] ?? "").toLowerCase(), await list(person));
      }
    }),
  );
  return result;
}
