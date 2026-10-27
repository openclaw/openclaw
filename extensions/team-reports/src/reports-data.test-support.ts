import { expect } from "vitest";
import { describePeriod } from "./periods.js";
import { githubCounts } from "./reports.fixtures.js";
import type { DiscordMessage, GithubItem, PersonReport, ReportDocument } from "./types.js";

export function githubItem(overrides: Partial<GithubItem> = {}): GithubItem {
  return {
    kind: "commit",
    repo: "sample/project",
    title: "Improve request handling",
    url: "https://github.com/sample/project/commit/one",
    atMs: Date.parse("2026-08-18T00:00:01Z"),
    actor: "alpha",
    ...overrides,
  };
}

export function discordMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    channelId: "100",
    parentChannelId: "100",
    channelName: "planning",
    authorId: "11",
    authorIsBot: false,
    atMs: Date.parse("2026-08-18T00:00:01Z"),
    content: "Discuss release readiness",
    ...overrides,
  };
}

export function reportMember(login: string, overrides: Partial<PersonReport> = {}): PersonReport {
  return {
    login,
    display: login,
    access: [],
    areas: [],
    aliases: [],
    github: { ...githubCounts(1), items: [] },
    discord: { total: 0, channels: {}, excerpts: [] },
    ...overrides,
  };
}

export function reportDocument(
  members: PersonReport[],
  overrides: Partial<ReportDocument> = {},
): ReportDocument {
  const period = overrides.period ?? describePeriod("day", "2026-08-20");
  return {
    version: 1,
    period,
    generatedAtMs: period.untilMs,
    status: "closed",
    orgs: ["example"],
    memberCount: members.length,
    activeMembers: members.filter((member) => member.github.total + member.discord.total > 0)
      .length,
    totals: {
      github: githubCounts(members.reduce((total, member) => total + member.github.total, 0)),
      discord: { messages: 0, channels: {} },
    },
    members,
    otherActors: [],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: [], stats: {} } },
    ...overrides,
  };
}

export async function measureReads<T>(
  reads: { enabled: boolean; calls: number; bytes: number },
  work: () => Promise<T>,
): Promise<T> {
  Object.assign(reads, { enabled: true, calls: 0, bytes: 0 });
  let result: T;
  try {
    result = await work();
  } finally {
    reads.enabled = false;
  }
  expect(reads.calls).toBeGreaterThan(0);
  return result;
}
