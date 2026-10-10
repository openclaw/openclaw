import fsp from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { listGoogleMeetCalendarEvents, type GoogleMeetCalendarLookupResult } from "./calendar.js";
import {
  formatDuration,
  formatOptional,
  type GoogleMeetExportRequest,
  type GoogleMeetExportWarning,
  writeStdoutLine,
} from "./cli-shared.js";
import type {
  GoogleMeetArtifactsResult,
  GoogleMeetAttendanceResult,
  GoogleMeetLatestConferenceRecordResult,
} from "./meet-api.js";

function appendArtifactSummary(
  lines: string[],
  entry: GoogleMeetArtifactsResult["artifacts"][number],
): void {
  if (entry.smartNotesError) {
    lines.push(`smart notes warning: ${entry.smartNotesError}`);
  }
  for (const recording of entry.recordings) {
    lines.push(`- recording: ${recording.name}`);
  }
  for (const transcript of entry.transcripts) {
    lines.push(`- transcript: ${transcript.name}`);
    if (transcript.documentTextError) {
      lines.push(`- transcript document body warning: ${transcript.documentTextError}`);
    }
  }
  for (const transcriptEntries of entry.transcriptEntries) {
    if (transcriptEntries.entriesError) {
      lines.push(
        `- transcript entries warning: ${transcriptEntries.transcript}: ${transcriptEntries.entriesError}`,
      );
    }
  }
  for (const smartNote of entry.smartNotes) {
    lines.push(`- smart note: ${smartNote.name}`);
    if (smartNote.documentTextError) {
      lines.push(`- smart note document body warning: ${smartNote.documentTextError}`);
    }
  }
}

function createReport(
  title: string,
  result: Pick<GoogleMeetArtifactsResult, "input" | "space" | "conferenceRecords">,
  format: "summary" | "markdown",
) {
  const markdown = format === "markdown";
  const lines: string[] = markdown ? [`# Google Meet ${title}`] : [];
  const field = (label: string, value: string | number) => {
    lines.push(`${markdown ? label : label.toLowerCase()}: ${value}`);
  };
  if (result.input) {
    field("Input", result.input);
  }
  if (result.space) {
    field("Space", result.space.name);
  }
  if (markdown) {
    lines.push("");
  }
  field("Conference records", result.conferenceRecords.length);
  return { markdown, lines, field };
}

export function renderAttendance(
  result: GoogleMeetAttendanceResult,
  format: "summary" | "markdown",
): string {
  const { markdown, lines, field } = createReport("Attendance", result, format);
  field("Attendance rows", result.attendance.length);
  for (const row of result.attendance) {
    const identity = row.displayName || row.user || row.participant;
    lines.push("", markdown ? `## ${identity}` : `participant: ${identity}`);
    field("Record", row.conferenceRecord);
    field("Resource", row.participant);
    field("Participants merged", row.participants?.length ?? 1);
    field("First joined", formatOptional(row.firstJoinTime ?? row.earliestStartTime));
    field("Last left", formatOptional(row.lastLeaveTime ?? row.latestEndTime));
    field("Duration", formatDuration(row.durationMs));
    field("Late", row.late ? formatDuration(row.lateByMs) : "no");
    field("Early leave", row.earlyLeave ? formatDuration(row.earlyLeaveByMs) : "no");
    field("Sessions", row.sessions.length);
    for (const session of row.sessions) {
      lines.push(
        `- ${session.name}: ${formatOptional(session.startTime)} -> ${formatOptional(session.endTime)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeLatestConferenceRecordSummary(
  result: GoogleMeetLatestConferenceRecordResult,
): void {
  writeStdoutLine("input: %s", result.input);
  writeStdoutLine("space: %s", result.space.name);
  if (!result.conferenceRecord) {
    writeStdoutLine("conference record: none");
    return;
  }
  writeStdoutLine("conference record: %s", result.conferenceRecord.name);
  writeStdoutLine("started: %s", formatOptional(result.conferenceRecord.startTime));
  writeStdoutLine("ended: %s", formatOptional(result.conferenceRecord.endTime));
}

export function writeCalendarEventsSummary(
  result: Awaited<ReturnType<typeof listGoogleMeetCalendarEvents>>,
): void {
  writeStdoutLine("calendar: %s", result.calendarId);
  writeStdoutLine("meet events: %d", result.events.length);
  for (const entry of result.events) {
    writeStdoutLine("");
    writeStdoutLine("%s%s", entry.selected ? "* " : "- ", entry.event.summary ?? "untitled");
    writeStdoutLine("meeting uri: %s", entry.meetingUri);
    writeStdoutLine(
      "starts: %s",
      formatOptional(entry.event.start?.dateTime ?? entry.event.start?.date),
    );
    writeStdoutLine("ends: %s", formatOptional(entry.event.end?.dateTime ?? entry.event.end?.date));
  }
}

function participantDisplayName(
  entry: GoogleMeetArtifactsResult["artifacts"][number],
  name: string,
): string {
  const participant = entry.participants.find((candidate) => candidate.name === name);
  if (!participant) {
    return name;
  }
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName ??
    participant.signedinUser?.user ??
    name
  );
}

function appendArtifactDocuments(
  lines: string[],
  title: string,
  documents: GoogleMeetArtifactsResult["artifacts"][number]["transcripts"],
): void {
  if (documents.length === 0) {
    return;
  }
  lines.push("", `### ${title}`);
  for (const document of documents) {
    lines.push(`- ${document.name}`);
    if (document.documentTextError) {
      lines.push(`  - Document body warning: ${document.documentTextError}`);
    } else if (document.documentText) {
      lines.push(`  - Document body: ${document.documentText.length} chars`);
    }
  }
}

export function renderArtifacts(
  result: GoogleMeetArtifactsResult,
  format: "summary" | "markdown",
): string {
  const { markdown, lines, field } = createReport("Artifacts", result, format);
  for (const entry of result.artifacts) {
    lines.push("", `${markdown ? "##" : "record:"} ${entry.conferenceRecord.name}`);
    field("Started", formatOptional(entry.conferenceRecord.startTime));
    field("Ended", formatOptional(entry.conferenceRecord.endTime));
    if (markdown) {
      lines.push("");
    }
    field("Participants", entry.participants.length);
    field("Recordings", entry.recordings.length);
    field("Transcripts", entry.transcripts.length);
    field(
      "Transcript entries",
      entry.transcriptEntries.reduce((count, transcript) => count + transcript.entries.length, 0),
    );
    field("Smart notes", entry.smartNotes.length);
    if (!markdown) {
      appendArtifactSummary(lines, entry);
      continue;
    }
    const warnings = collectGoogleMeetArtifactWarnings({
      conferenceRecords: [entry.conferenceRecord],
      artifacts: [entry],
    });
    if (warnings.length > 0) {
      lines.push("");
      lines.push("### Warnings");
      for (const warning of warnings) {
        const resource = warning.resource ? `${warning.resource}: ` : "";
        lines.push(`- ${resource}${warning.message}`);
      }
    }
    if (entry.recordings.length > 0) {
      lines.push("");
      lines.push("### Recordings");
      for (const recording of entry.recordings) {
        lines.push(`- ${recording.name}`);
      }
    }
    appendArtifactDocuments(lines, "Transcripts", entry.transcripts);
    for (const transcriptEntries of entry.transcriptEntries) {
      lines.push("");
      lines.push(`### Transcript Entries: ${transcriptEntries.transcript}`);
      if (transcriptEntries.entriesError) {
        lines.push(`Warning: ${transcriptEntries.entriesError}`);
        continue;
      }
      if (transcriptEntries.entries.length === 0) {
        lines.push("_No transcript entries._");
        continue;
      }
      for (const transcriptEntry of transcriptEntries.entries) {
        const times =
          transcriptEntry.startTime || transcriptEntry.endTime
            ? ` (${formatOptional(transcriptEntry.startTime)} -> ${formatOptional(
                transcriptEntry.endTime,
              )})`
            : "";
        const speaker = transcriptEntry.participant
          ? `${participantDisplayName(entry, transcriptEntry.participant)}: `
          : "";
        lines.push(`- ${speaker}${transcriptEntry.text ?? ""}${times}`);
      }
    }
    appendArtifactDocuments(lines, "Smart Notes", entry.smartNotes);
  }
  return `${lines.join("\n")}\n`;
}

function neutralizeSpreadsheetFormulaCell(text: string): string {
  return /^[ \t\r\n]*[=+\-@\uFF0B\uFF0D\uFF1D\uFF20]/u.test(text) || /^[\t\r\n]/.test(text)
    ? `'${text}`
    : text;
}

function csvCell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  const safeText = neutralizeSpreadsheetFormulaCell(text);
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

export function renderAttendanceCsv(result: GoogleMeetAttendanceResult): string {
  const rows: unknown[][] = [
    [
      "conferenceRecord",
      "displayName",
      "user",
      "participants",
      "firstJoined",
      "lastLeft",
      "durationMs",
      "sessions",
      "late",
      "lateByMs",
      "earlyLeave",
      "earlyLeaveByMs",
    ],
  ];
  for (const row of result.attendance) {
    rows.push([
      row.conferenceRecord,
      row.displayName ?? "",
      row.user ?? "",
      (row.participants ?? [row.participant]).join(";"),
      row.firstJoinTime ?? row.earliestStartTime ?? "",
      row.lastLeaveTime ?? row.latestEndTime ?? "",
      row.durationMs ?? "",
      row.sessions.length,
      row.late ?? "",
      row.lateByMs ?? "",
      row.earlyLeave ?? "",
      row.earlyLeaveByMs ?? "",
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderTranscriptMarkdown(result: GoogleMeetArtifactsResult): string {
  const lines: string[] = ["# Google Meet Transcript"];
  if (result.input) {
    lines.push(`Input: ${result.input}`);
  }
  for (const entry of result.artifacts) {
    lines.push("");
    lines.push(`## ${entry.conferenceRecord.name}`);
    if (entry.transcriptEntries.length === 0) {
      lines.push("_No transcript entries._");
      continue;
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      lines.push("");
      lines.push(`### ${transcriptEntries.transcript}`);
      if (transcriptEntries.entriesError) {
        lines.push(`Warning: ${transcriptEntries.entriesError}`);
        continue;
      }
      for (const transcriptEntry of transcriptEntries.entries) {
        const speaker = transcriptEntry.participant
          ? participantDisplayName(entry, transcriptEntry.participant)
          : "unknown";
        const time = transcriptEntry.startTime ? ` [${transcriptEntry.startTime}]` : "";
        lines.push(`- ${speaker}${time}: ${transcriptEntry.text ?? ""}`);
      }
    }
    for (const [title, documents] of [
      ["Transcript Document Bodies", entry.transcripts],
      ["Smart Note Document Bodies", entry.smartNotes],
    ] as const) {
      const bodies = documents.filter((document) => document.documentText);
      if (bodies.length > 0) {
        lines.push("", `### ${title}`);
        for (const document of bodies) {
          lines.push("", `#### ${document.name}`);
          lines.push(document.documentText?.trim() || "_Empty document body._");
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function collectGoogleMeetArtifactWarnings(
  result: GoogleMeetArtifactsResult,
): GoogleMeetExportWarning[] {
  const warnings: GoogleMeetExportWarning[] = [];
  for (const entry of result.artifacts) {
    const conferenceRecord = entry.conferenceRecord.name;
    if (entry.smartNotesError) {
      warnings.push({
        type: "smart_notes",
        conferenceRecord,
        message: entry.smartNotesError,
      });
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      if (transcriptEntries.entriesError) {
        warnings.push({
          type: "transcript_entries",
          conferenceRecord,
          resource: transcriptEntries.transcript,
          message: transcriptEntries.entriesError,
        });
      }
    }
    for (const [type, documents] of [
      ["transcript_document_body", entry.transcripts],
      ["smart_note_document_body", entry.smartNotes],
    ] as const) {
      for (const document of documents) {
        if (document.documentTextError) {
          warnings.push({
            type,
            conferenceRecord,
            resource: document.name,
            message: document.documentTextError,
          });
        }
      }
    }
  }
  return warnings;
}

export function buildGoogleMeetExportManifest(params: {
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  files: string[];
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
  zipFile?: string;
}) {
  const warnings = collectGoogleMeetArtifactWarnings(params.artifacts);
  const counts = {
    conferenceRecords: params.artifacts.conferenceRecords.length,
    artifacts: params.artifacts.artifacts.length,
    attendanceRows: params.attendance.attendance.length,
    recordings: 0,
    transcripts: 0,
    transcriptEntries: 0,
    smartNotes: 0,
    warnings: warnings.length,
  };
  for (const entry of params.artifacts.artifacts) {
    counts.recordings += entry.recordings.length;
    counts.transcripts += entry.transcripts.length;
    counts.smartNotes += entry.smartNotes.length;
    for (const transcript of entry.transcriptEntries) {
      counts.transcriptEntries += transcript.entries.length;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    ...(params.request ? { request: params.request } : {}),
    ...(params.tokenSource ? { tokenSource: params.tokenSource } : {}),
    ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
    inputs: {
      ...(params.artifacts.input ? { artifacts: params.artifacts.input } : {}),
      ...(params.attendance.input ? { attendance: params.attendance.input } : {}),
    },
    counts,
    conferenceRecords: params.artifacts.conferenceRecords.map((record) => record.name),
    files: params.files,
    ...(params.zipFile ? { zipFile: params.zipFile } : {}),
    warnings,
  };
}

export function googleMeetExportFileNames(): string[] {
  return [
    "summary.md",
    "attendance.csv",
    "transcript.md",
    "artifacts.json",
    "attendance.json",
    "manifest.json",
  ];
}

function defaultExportDirectory(): string {
  return `google-meet-export-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function publishMeetExportFile(outputPath: string, content: string | Buffer): Promise<void> {
  const absolutePath = path.resolve(outputPath);
  await writeExternalFileWithinRoot({
    rootDir: path.dirname(absolutePath),
    path: path.basename(absolutePath),
    write: async (tempPath) => {
      await fsp.writeFile(tempPath, content);
    },
  });
}

export async function writeMeetExportBundle(params: {
  outputDir?: string;
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  zip?: boolean;
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
}): Promise<{ outputDir: string; files: string[]; zipFile?: string }> {
  const outputDir = params.outputDir?.trim() || defaultExportDirectory();
  await fsp.mkdir(outputDir, { recursive: true });
  let zipOutputDir = outputDir;
  if (params.zip) {
    const resolvedOutputDir = path.resolve(outputDir);
    if (resolvedOutputDir !== path.parse(resolvedOutputDir).root) {
      // POSIX backslashes are filename characters; Windows accepts both separator spellings.
      zipOutputDir = outputDir.replace(path.sep === "\\" ? /[\\/]+$/ : /\/+$/, "");
    }
  }
  const zipFile = params.zip ? `${zipOutputDir.replace(/\/$/, "")}.zip` : undefined;
  const fileNames = googleMeetExportFileNames();
  const files = [
    {
      name: "summary.md",
      content: `${renderArtifacts(params.artifacts, "markdown")}\n${renderAttendance(params.attendance, "markdown")}`,
    },
    { name: "attendance.csv", content: renderAttendanceCsv(params.attendance) },
    { name: "transcript.md", content: renderTranscriptMarkdown(params.artifacts) },
    { name: "artifacts.json", content: `${JSON.stringify(params.artifacts, null, 2)}\n` },
    { name: "attendance.json", content: `${JSON.stringify(params.attendance, null, 2)}\n` },
    {
      name: "manifest.json",
      content: `${JSON.stringify(
        buildGoogleMeetExportManifest({
          artifacts: params.artifacts,
          attendance: params.attendance,
          files: fileNames,
          ...(params.request ? { request: params.request } : {}),
          ...(params.tokenSource ? { tokenSource: params.tokenSource } : {}),
          ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
          ...(zipFile ? { zipFile } : {}),
        }),
        null,
        2,
      )}\n`,
    },
  ];
  for (const file of files) {
    await publishMeetExportFile(path.join(outputDir, file.name), file.content);
  }
  const result: { outputDir: string; files: string[]; zipFile?: string } = {
    outputDir,
    files: files.map((file) => path.join(outputDir, file.name)),
  };
  if (zipFile) {
    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.name, file.content);
    }
    await publishMeetExportFile(zipFile, await zip.generateAsync({ type: "nodebuffer" }));
    result.zipFile = zipFile;
  }
  return result;
}

export async function exportGoogleMeetBundle(
  params: Parameters<typeof writeMeetExportBundle>[0] & { dryRun?: boolean },
) {
  const metadata = {
    ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
    tokenSource: params.tokenSource,
  };
  if (params.dryRun) {
    return {
      dryRun: true,
      manifest: buildGoogleMeetExportManifest({
        artifacts: params.artifacts,
        attendance: params.attendance,
        files: googleMeetExportFileNames(),
        request: params.request,
        ...metadata,
      }),
      ...metadata,
    };
  }
  return { ...(await writeMeetExportBundle(params)), ...metadata };
}
