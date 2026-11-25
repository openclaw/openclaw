import type {
  TranscriptSessionSummary,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type MeetingSeed = {
  id: string;
  title: string;
  providerId: string;
  providerName: string;
  ageMs: number;
  durationMs?: number;
  utteranceCount: number;
  participants: string[];
  overview?: string;
  source?: Omit<TranscriptSessionSummary["source"], "providerId">;
};

const SEEDS: readonly MeetingSeed[] = [
  {
    id: "release-readiness",
    title: "Release readiness sync",
    providerId: "discord-voice",
    providerName: "Discord voice",
    ageMs: 12 * MINUTE_MS,
    utteranceCount: 18,
    participants: ["Ada", "Sam", "Jo"],
    overview: "The team is walking through the open release blockers.",
    source: { accountId: "workspace-primary", guildId: "1204", channelId: "standup" },
  },
  {
    id: "onboarding-review",
    title: "Design review: onboarding flow and the accessible navigation pass before launch",
    providerId: "google-meet",
    providerName: "Google Meet",
    ageMs: 3 * HOUR_MS,
    durationMs: 47 * MINUTE_MS,
    utteranceCount: 42,
    participants: ["Ada", "Sam", "Jo", "Alex", "Noor"],
    overview:
      "Agreed on a three-step first run and a focused launch checklist, with keyboard navigation reviewed before the prototype goes out for testing.",
    source: {
      accountId: "workspace-primary",
      meetingUrl: "https://meet.example.com/onboarding-review-weekly?authuser=0&region=us-east-1",
    },
  },
  {
    id: "quiet-check-in",
    title: "Quiet check-in",
    providerId: "discord-voice",
    providerName: "Discord voice",
    ageMs: 5 * HOUR_MS,
    durationMs: MINUTE_MS,
    utteranceCount: 0,
    participants: [],
  },
  {
    id: "launch-planning",
    title: "Launch planning",
    providerId: "google-meet",
    providerName: "Google Meet",
    ageMs: 27 * HOUR_MS,
    durationMs: 32 * MINUTE_MS,
    utteranceCount: 96,
    participants: ["Sam", "Noor"],
    overview: "Moved the announcement by one week so the docs can ship with the release.",
  },
  {
    id: "infrastructure-review",
    title: "Weekly infrastructure review",
    providerId: "discord-voice",
    providerName: "Discord voice",
    ageMs: 30 * HOUR_MS,
    durationMs: 58 * MINUTE_MS,
    utteranceCount: 210,
    participants: ["Jo", "Alex"],
  },
];

const OLDER_SEEDS: readonly MeetingSeed[] = [
  {
    id: "support-triage",
    title: "Support triage",
    providerId: "discord-voice",
    providerName: "Discord voice",
    ageMs: 76 * HOUR_MS,
    durationMs: 21 * MINUTE_MS,
    utteranceCount: 64,
    participants: ["Ada", "Noor"],
    overview: "Grouped the open reports by owner and closed the duplicates.",
  },
];

function day(startedAtMs: number) {
  return new Date(startedAtMs).toISOString().slice(0, 10);
}

function buildSummary(seed: MeetingSeed, now: number): TranscriptSessionSummary {
  const startedAtMs = now - seed.ageMs;
  const stoppedAtMs = seed.durationMs === undefined ? undefined : startedAtMs + seed.durationMs;
  const updatedAt = new Date(stoppedAtMs ?? now).toISOString();
  return {
    selector: `${day(startedAtMs)}/${seed.id}`,
    sessionId: seed.id,
    title: seed.title,
    providerId: seed.providerId,
    providerName: seed.providerName,
    source: { providerId: seed.providerId, ...seed.source },
    startedAt: new Date(startedAtMs).toISOString(),
    stoppedAt: stoppedAtMs === undefined ? undefined : new Date(stoppedAtMs).toISOString(),
    active: stoppedAtMs === undefined,
    activeSubscription: stoppedAtMs === undefined,
    agentId: "main",
    updatedAt,
    lastUtteranceAt: seed.utteranceCount > 0 ? updatedAt : null,
    utteranceCount: seed.utteranceCount,
    participants: seed.participants,
    hasSummary: Boolean(seed.overview),
    summarySource: seed.overview ? "model" : undefined,
    overview: seed.overview,
  };
}

function buildNotes(session: TranscriptSessionSummary): TranscriptsGetResult["summary"] {
  const overview = session.overview ?? "";
  return {
    generatedAt: session.updatedAt,
    overview,
    decisions: ["Keep the first-run setup to three steps."],
    actionItems: ["Ada: prepare the revised prototype."],
    risks: ["Leave time for mobile testing."],
    participants: session.participants,
    utteranceCount: session.utteranceCount,
    source: "model",
    markdown: [
      `# ${session.title}`,
      "## Overview",
      overview,
      "## Participants",
      session.participants.map((name) => `- ${name}`).join("\n"),
      "## Decisions",
      "- Keep the first-run setup to three steps.\n- Ship the accessible navigation before launch.",
      "## Action Items",
      "- Ada: prepare the revised prototype and share it with the review group before Thursday.\n- Sam: review keyboard navigation.",
      "## Risks",
      "- Leave time for mobile testing.",
      "## Follow-up command",
      "```\nopenclaw transcripts export --format markdown --selector 2026-10-31/onboarding-review --output ./notes/onboarding-review.md\n```",
    ].join("\n\n"),
  };
}

function buildUtterances(session: TranscriptSessionSummary): TranscriptsGetResult["utterances"] {
  const startedAtMs = Date.parse(session.startedAt);
  const lines = [
    "Let's keep the setup simple and stop asking for anything we can infer.",
    "Agreed. The second step can go away if we read the workspace name from the invite.",
    "I'll check keyboard navigation this afternoon. The draft is at https://docs.example.com/design/onboarding-review/navigation-pass-for-the-first-run-flow if anyone wants to follow along.",
    "Then the prototype can go out for testing tomorrow.",
  ];
  if (session.utteranceCount === 0) {
    return [];
  }
  return lines.map((text, sequence) => ({
    sequence,
    speakerLabel: session.participants[sequence % session.participants.length],
    startedAt: new Date(startedAtMs + (sequence + 1) * MINUTE_MS).toISOString(),
    text,
    final: true,
  }));
}

function buildDetail(session: TranscriptSessionSummary): TranscriptsGetResult {
  return {
    session,
    nextCursor: null,
    utterances: buildUtterances(session),
    ...(session.hasSummary ? { summary: buildNotes(session) } : {}),
  };
}

/** Saved meetings for `--fixture meetings`: a live capture, silent and summary-less rows, a second page. */
export function buildMeetingsMocks(now: number) {
  const firstPage = SEEDS.map((seed) => buildSummary(seed, now));
  const olderPage = OLDER_SEEDS.map((seed) => buildSummary(seed, now));
  const sessions = [...firstPage, ...olderPage];
  const page = (rows: TranscriptSessionSummary[], nextCursor: string | null) =>
    ({ sessions: rows, nextCursor }) satisfies TranscriptsListResult;
  return {
    "transcripts.list": {
      cases: [
        { match: { cursor: "page-2" }, response: page(olderPage, null) },
        {
          match: { providerId: "google-meet" },
          response: page(
            sessions.filter((session) => session.providerId === "google-meet"),
            null,
          ),
        },
        {
          match: { query: "launch" },
          response: page(
            sessions.filter((session) => /launch/iu.test(session.title ?? "")),
            null,
          ),
        },
        { match: { query: "no such meeting" }, response: page([], null) },
        { match: {}, response: page(firstPage, "page-2") },
      ],
    },
    "transcripts.get": {
      cases: sessions.map((session) => ({
        match: { selector: session.selector },
        response: buildDetail(session),
      })),
    },
    "transcripts.export": {
      cases: sessions.map((session) => {
        const data = Buffer.from(`# ${session.title}\n`).toString("base64");
        return {
          match: { selector: session.selector },
          response: {
            selector: session.selector,
            filename: `${session.sessionId}.md`,
            mimeType: "text/markdown",
            encoding: "base64",
            data,
            sizeBytes: Buffer.byteLength(`# ${session.title}\n`),
          },
        };
      }),
    },
    "transcripts.summarize": {
      cases: sessions.map((session) => ({
        match: { selector: session.selector },
        response: buildDetail({
          ...session,
          hasSummary: true,
          summarySource: "model",
          overview: "Reviewed capacity and agreed to move the nightly jobs off the shared runner.",
        }),
      })),
    },
  };
}
