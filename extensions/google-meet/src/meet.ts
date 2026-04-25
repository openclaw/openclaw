import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const GOOGLE_MEET_API_ORIGIN = "https://meet.googleapis.com";
const GOOGLE_MEET_API_BASE_URL = `${GOOGLE_MEET_API_ORIGIN}/v2`;
const GOOGLE_MEET_URL_HOST = "meet.google.com";
const GOOGLE_MEET_API_HOST = "meet.googleapis.com";

export type GoogleMeetSpace = {
  name: string;
  meetingCode?: string;
  meetingUri?: string;
  activeConference?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

export type GoogleMeetPreflightReport = {
  input: string;
  resolvedSpaceName: string;
  meetingCode?: string;
  meetingUri?: string;
  hasActiveConference: boolean;
  previewAcknowledged: boolean;
  tokenSource: "cached-access-token" | "refresh-token";
  blockers: string[];
};

export type GoogleMeetCreateSpaceResult = {
  space: GoogleMeetSpace;
  meetingUri: string;
};

export type GoogleMeetConferenceRecord = {
  name: string;
  space?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
};

export type GoogleMeetParticipant = {
  name: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: {
    user?: string;
    displayName?: string;
  };
  anonymousUser?: {
    displayName?: string;
  };
  phoneUser?: {
    displayName?: string;
  };
};

export type GoogleMeetParticipantSession = {
  name: string;
  startTime?: string;
  endTime?: string;
};

export type GoogleMeetRecording = {
  name: string;
  startTime?: string;
  endTime?: string;
  driveDestination?: Record<string, unknown>;
};

export type GoogleMeetTranscript = {
  name: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: Record<string, unknown>;
};

export type GoogleMeetSmartNote = {
  name: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: Record<string, unknown>;
};

export type GoogleMeetArtifactsEntry = {
  conferenceRecord: GoogleMeetConferenceRecord;
  participants: GoogleMeetParticipant[];
  recordings: GoogleMeetRecording[];
  transcripts: GoogleMeetTranscript[];
  smartNotes: GoogleMeetSmartNote[];
  smartNotesError?: string;
};

export type GoogleMeetArtifactsResult = {
  input?: string;
  space?: GoogleMeetSpace;
  conferenceRecords: GoogleMeetConferenceRecord[];
  artifacts: GoogleMeetArtifactsEntry[];
};

export type GoogleMeetAttendanceRow = {
  conferenceRecord: string;
  participant: string;
  displayName?: string;
  user?: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  sessions: GoogleMeetParticipantSession[];
};

export type GoogleMeetAttendanceResult = {
  input?: string;
  space?: GoogleMeetSpace;
  conferenceRecords: GoogleMeetConferenceRecord[];
  attendance: GoogleMeetAttendanceRow[];
};

type GoogleMeetSmartNotesListResult = {
  smartNotes: GoogleMeetSmartNote[];
  smartNotesError?: string;
};

export function normalizeGoogleMeetSpaceName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Meeting input is required");
  }
  if (trimmed.startsWith("spaces/")) {
    const suffix = trimmed.slice("spaces/".length).trim();
    if (!suffix) {
      throw new Error("spaces/ input must include a meeting code or space id");
    }
    return `spaces/${suffix}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.hostname !== GOOGLE_MEET_URL_HOST) {
      throw new Error(`Expected a ${GOOGLE_MEET_URL_HOST} URL, received ${url.hostname}`);
    }
    const firstSegment = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .find(Boolean);
    if (!firstSegment) {
      throw new Error("Google Meet URL did not include a meeting code");
    }
    return `spaces/${firstSegment}`;
  }
  return `spaces/${trimmed}`;
}

function encodeSpaceNameForPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function encodeResourceNameForPath(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Google Meet resource name is required");
  }
  return trimmed.split("/").map(encodeURIComponent).join("/");
}

function normalizeConferenceRecordName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Conference record is required");
  }
  return trimmed.startsWith("conferenceRecords/") ? trimmed : `conferenceRecords/${trimmed}`;
}

function appendQuery(
  url: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) {
    return url;
  }
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function assertResourceArray<T extends { name?: string }>(
  value: unknown,
  key: string,
  context: string,
): T[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Google Meet ${context} response had non-array ${key}`);
  }
  const resources = value as T[];
  for (const resource of resources) {
    if (!resource.name?.trim()) {
      throw new Error(`Google Meet ${context} response included a resource without name`);
    }
  }
  return resources;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchGoogleMeetJson<T>(params: {
  accessToken: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  auditContext: string;
  errorPrefix: string;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: appendQuery(`${GOOGLE_MEET_API_BASE_URL}/${params.path}`, params.query),
    init: {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
      },
    },
    policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
    auditContext: params.auditContext,
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${params.errorPrefix} failed (${response.status}): ${detail}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

async function listGoogleMeetCollection<T extends { name?: string }>(params: {
  accessToken: string;
  path: string;
  collectionKey: string;
  query?: Record<string, string | number | boolean | undefined>;
  auditContext: string;
  errorPrefix: string;
}): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const payload = await fetchGoogleMeetJson<Record<string, unknown>>({
      accessToken: params.accessToken,
      path: params.path,
      query: { ...params.query, pageToken },
      auditContext: params.auditContext,
      errorPrefix: params.errorPrefix,
    });
    items.push(
      ...assertResourceArray<T>(
        payload[params.collectionKey],
        params.collectionKey,
        params.errorPrefix,
      ),
    );
    pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : undefined;
  } while (pageToken);
  return items;
}

export async function fetchGoogleMeetSpace(params: {
  accessToken: string;
  meeting: string;
}): Promise<GoogleMeetSpace> {
  const name = normalizeGoogleMeetSpaceName(params.meeting);
  const { response, release } = await fetchWithSsrFGuard({
    url: `${GOOGLE_MEET_API_BASE_URL}/${encodeSpaceNameForPath(name)}`,
    init: {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
      },
    },
    policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
    auditContext: "google-meet.spaces.get",
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google Meet spaces.get failed (${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as GoogleMeetSpace;
    if (!payload.name?.trim()) {
      throw new Error("Google Meet spaces.get response was missing name");
    }
    return payload;
  } finally {
    await release();
  }
}

export async function createGoogleMeetSpace(params: {
  accessToken: string;
}): Promise<GoogleMeetCreateSpaceResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${GOOGLE_MEET_API_BASE_URL}/spaces`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
    auditContext: "google-meet.spaces.create",
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google Meet spaces.create failed (${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as GoogleMeetSpace;
    if (!payload.name?.trim()) {
      throw new Error("Google Meet spaces.create response was missing name");
    }
    const meetingUri = payload.meetingUri?.trim();
    if (!meetingUri) {
      throw new Error("Google Meet spaces.create response was missing meetingUri");
    }
    return { space: payload, meetingUri };
  } finally {
    await release();
  }
}

export async function fetchGoogleMeetConferenceRecord(params: {
  accessToken: string;
  conferenceRecord: string;
}): Promise<GoogleMeetConferenceRecord> {
  const name = normalizeConferenceRecordName(params.conferenceRecord);
  const payload = await fetchGoogleMeetJson<GoogleMeetConferenceRecord>({
    accessToken: params.accessToken,
    path: encodeResourceNameForPath(name),
    auditContext: "google-meet.conferenceRecords.get",
    errorPrefix: "Google Meet conferenceRecords.get",
  });
  if (!payload.name?.trim()) {
    throw new Error("Google Meet conferenceRecords.get response was missing name");
  }
  return payload;
}

export async function listGoogleMeetConferenceRecords(params: {
  accessToken: string;
  meeting?: string;
  pageSize?: number;
}): Promise<GoogleMeetConferenceRecord[]> {
  const filter = params.meeting
    ? `space.name = "${normalizeGoogleMeetSpaceName(params.meeting)}"`
    : undefined;
  return listGoogleMeetCollection<GoogleMeetConferenceRecord>({
    accessToken: params.accessToken,
    path: "conferenceRecords",
    collectionKey: "conferenceRecords",
    query: {
      pageSize: params.pageSize,
      filter,
    },
    auditContext: "google-meet.conferenceRecords.list",
    errorPrefix: "Google Meet conferenceRecords.list",
  });
}

export async function listGoogleMeetParticipants(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetParticipant[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetParticipant>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/participants`,
    collectionKey: "participants",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.participants.list",
    errorPrefix: "Google Meet conferenceRecords.participants.list",
  });
}

export async function listGoogleMeetParticipantSessions(params: {
  accessToken: string;
  participant: string;
  pageSize?: number;
}): Promise<GoogleMeetParticipantSession[]> {
  return listGoogleMeetCollection<GoogleMeetParticipantSession>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(params.participant)}/participantSessions`,
    collectionKey: "participantSessions",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.participants.participantSessions.list",
    errorPrefix: "Google Meet conferenceRecords.participants.participantSessions.list",
  });
}

export async function listGoogleMeetRecordings(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetRecording[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetRecording>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/recordings`,
    collectionKey: "recordings",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.recordings.list",
    errorPrefix: "Google Meet conferenceRecords.recordings.list",
  });
}

export async function listGoogleMeetTranscripts(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetTranscript[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetTranscript>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/transcripts`,
    collectionKey: "transcripts",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.transcripts.list",
    errorPrefix: "Google Meet conferenceRecords.transcripts.list",
  });
}

export async function listGoogleMeetSmartNotes(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetSmartNote[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetSmartNote>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/smartNotes`,
    collectionKey: "smartNotes",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.smartNotes.list",
    errorPrefix: "Google Meet conferenceRecords.smartNotes.list",
  });
}

function getParticipantDisplayName(participant: GoogleMeetParticipant): string | undefined {
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName
  );
}

function getParticipantUser(participant: GoogleMeetParticipant): string | undefined {
  return participant.signedinUser?.user;
}

async function resolveConferenceRecordQuery(params: {
  accessToken: string;
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
}): Promise<{
  input?: string;
  space?: GoogleMeetSpace;
  conferenceRecords: GoogleMeetConferenceRecord[];
}> {
  if (params.conferenceRecord?.trim()) {
    const conferenceRecord = await fetchGoogleMeetConferenceRecord({
      accessToken: params.accessToken,
      conferenceRecord: params.conferenceRecord,
    });
    return {
      input: params.conferenceRecord.trim(),
      conferenceRecords: [conferenceRecord],
    };
  }
  if (!params.meeting?.trim()) {
    throw new Error("Meeting input or conference record is required");
  }
  const space = await fetchGoogleMeetSpace({
    accessToken: params.accessToken,
    meeting: params.meeting,
  });
  const conferenceRecords = await listGoogleMeetConferenceRecords({
    accessToken: params.accessToken,
    meeting: space.name,
    pageSize: params.pageSize,
  });
  return {
    input: params.meeting,
    space,
    conferenceRecords,
  };
}

export async function fetchGoogleMeetArtifacts(params: {
  accessToken: string;
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
}): Promise<GoogleMeetArtifactsResult> {
  const resolved = await resolveConferenceRecordQuery(params);
  const artifacts = await Promise.all(
    resolved.conferenceRecords.map(async (conferenceRecord) => {
      const [participants, recordings, transcripts, smartNotesResult] = await Promise.all([
        listGoogleMeetParticipants({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        }),
        listGoogleMeetRecordings({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        }),
        listGoogleMeetTranscripts({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        }),
        listGoogleMeetSmartNotes({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        })
          .then<GoogleMeetSmartNotesListResult>((smartNotes) => ({ smartNotes }))
          .catch((error: unknown) => ({
            smartNotes: [],
            smartNotesError: getErrorMessage(error),
          })),
      ]);
      return {
        conferenceRecord,
        participants,
        recordings,
        transcripts,
        smartNotes: smartNotesResult.smartNotes,
        ...(smartNotesResult.smartNotesError
          ? { smartNotesError: smartNotesResult.smartNotesError }
          : {}),
      };
    }),
  );
  return {
    input: resolved.input,
    space: resolved.space,
    conferenceRecords: resolved.conferenceRecords,
    artifacts,
  };
}

export async function fetchGoogleMeetAttendance(params: {
  accessToken: string;
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
}): Promise<GoogleMeetAttendanceResult> {
  const resolved = await resolveConferenceRecordQuery(params);
  const nestedRows = await Promise.all(
    resolved.conferenceRecords.map(async (conferenceRecord) => {
      const participants = await listGoogleMeetParticipants({
        accessToken: params.accessToken,
        conferenceRecord: conferenceRecord.name,
        pageSize: params.pageSize,
      });
      return Promise.all(
        participants.map(async (participant) => ({
          conferenceRecord: conferenceRecord.name,
          participant: participant.name,
          displayName: getParticipantDisplayName(participant),
          user: getParticipantUser(participant),
          earliestStartTime: participant.earliestStartTime,
          latestEndTime: participant.latestEndTime,
          sessions: await listGoogleMeetParticipantSessions({
            accessToken: params.accessToken,
            participant: participant.name,
            pageSize: params.pageSize,
          }),
        })),
      );
    }),
  );
  return {
    input: resolved.input,
    space: resolved.space,
    conferenceRecords: resolved.conferenceRecords,
    attendance: nestedRows.flat(),
  };
}

export function buildGoogleMeetPreflightReport(params: {
  input: string;
  space: GoogleMeetSpace;
  previewAcknowledged: boolean;
  tokenSource: "cached-access-token" | "refresh-token";
}): GoogleMeetPreflightReport {
  const blockers: string[] = [];
  if (!params.previewAcknowledged) {
    blockers.push(
      "Set preview.enrollmentAcknowledged=true after confirming your Cloud project, OAuth principal, and meeting participants are enrolled in the Google Workspace Developer Preview Program.",
    );
  }
  return {
    input: params.input,
    resolvedSpaceName: params.space.name,
    meetingCode: params.space.meetingCode,
    meetingUri: params.space.meetingUri,
    hasActiveConference: Boolean(params.space.activeConference),
    previewAcknowledged: params.previewAcknowledged,
    tokenSource: params.tokenSource,
    blockers,
  };
}
