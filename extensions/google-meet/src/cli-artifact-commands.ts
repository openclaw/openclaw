import {
  addGoogleMeetArtifactOptions,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
import {
  buildGoogleMeetExportManifest,
  googleMeetExportFileNames,
  renderArtifactsMarkdown,
  renderArtifactsSummary,
  renderAttendanceCsv,
  renderAttendanceMarkdown,
  renderAttendanceSummary,
  writeMeetExportBundle,
} from "./cli-export.js";
import {
  type GoogleMeetExportRequest,
  type MeetArtifactOptions,
  writeCliOutput,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import {
  fetchResolvedGoogleMeetArtifacts,
  fetchResolvedGoogleMeetAttendance,
  resolveArtifactQueryFromParams,
} from "./plugin-helpers.js";

async function resolveCliArtifactQuery(
  context: GoogleMeetCliCommandContext,
  options: MeetArtifactOptions,
) {
  const { lateAfterMinutes, earlyBeforeMinutes, ...raw } =
    context.resolveCliArtifactParams(options);
  return {
    ...(await resolveArtifactQueryFromParams(context.config, raw)),
    lateAfterMinutes,
    earlyBeforeMinutes,
  };
}

function resolveTokenSource(refreshed: boolean) {
  return refreshed ? "refresh-token" : "cached-access-token";
}

export function registerGoogleMeetArtifactCommands(context: GoogleMeetCliCommandContext): void {
  const params = context;
  const { root } = context;

  addGoogleMeetArtifactOptions(
    root
      .command("artifacts")
      .description("List Meet conference records and available participant/artifact metadata"),
  )
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--format <format>", "Output format: summary or markdown", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(params, options);
      const result = await fetchResolvedGoogleMeetArtifacts(resolved);
      const tokenSource = resolveTokenSource(resolved.token.refreshed);
      let text: string;
      if (options.json) {
        text = JSON.stringify(
          {
            ...result,
            tokenSource,
          },
          null,
          2,
        );
      } else if (options.format === "markdown") {
        text = renderArtifactsMarkdown(result);
      } else if (!options.format || options.format === "summary") {
        text = `${renderArtifactsSummary(result)}token source: ${tokenSource}\n`;
      } else {
        throw new Error("Unsupported format. Expected summary or markdown.");
      }
      await writeCliOutput(options, text);
    });

  addGoogleMeetArtifactOptions(
    root.command("attendance").description("List Meet participants and participant sessions"),
  )
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--format <format>", "Output format: summary, markdown, or csv", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(params, options);
      const result = await fetchResolvedGoogleMeetAttendance(resolved);
      const tokenSource = resolveTokenSource(resolved.token.refreshed);
      let text: string;
      if (options.json) {
        text = JSON.stringify(
          {
            ...result,
            tokenSource,
          },
          null,
          2,
        );
      } else if (options.format === "markdown") {
        text = renderAttendanceMarkdown(result);
      } else if (options.format === "csv") {
        text = renderAttendanceCsv(result);
      } else if (!options.format || options.format === "summary") {
        text = `${renderAttendanceSummary(result)}token source: ${tokenSource}\n`;
      } else {
        throw new Error("Unsupported format. Expected summary, markdown, or csv.");
      }
      await writeCliOutput(options, text);
    });

  addGoogleMeetArtifactOptions(
    root
      .command("export")
      .description("Write Meet artifacts, attendance, transcript, and raw JSON into a folder"),
  )
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--output <dir>", "Output directory")
    .option("--zip", "Also write a portable .zip archive")
    .option("--dry-run", "Fetch export data and print the manifest without writing files", false)
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = await resolveCliArtifactQuery(params, options);
      const artifacts = await fetchResolvedGoogleMeetArtifacts(resolved);
      const attendance = await fetchResolvedGoogleMeetAttendance(resolved);
      const request: GoogleMeetExportRequest = {
        ...(resolved.meeting ? { meeting: resolved.meeting } : {}),
        ...(resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {}),
        ...(resolved.calendarEvent?.event.id
          ? { calendarEventId: resolved.calendarEvent.event.id }
          : {}),
        ...(resolved.calendarEvent?.event.summary
          ? { calendarEventSummary: resolved.calendarEvent.event.summary }
          : {}),
        ...(options.calendar ? { calendarId: options.calendar } : {}),
        ...(resolved.pageSize !== undefined ? { pageSize: resolved.pageSize } : {}),
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        includeDocumentBodies: resolved.includeDocumentBodies,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        ...(resolved.lateAfterMinutes !== undefined
          ? { lateAfterMinutes: resolved.lateAfterMinutes }
          : {}),
        ...(resolved.earlyBeforeMinutes !== undefined
          ? { earlyBeforeMinutes: resolved.earlyBeforeMinutes }
          : {}),
      };
      if (options.dryRun) {
        writeStdoutJson({
          dryRun: true,
          manifest: buildGoogleMeetExportManifest({
            artifacts,
            attendance,
            files: googleMeetExportFileNames(),
            request,
            tokenSource: resolveTokenSource(resolved.token.refreshed),
            ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          }),
          ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          tokenSource: resolveTokenSource(resolved.token.refreshed),
        });
        return;
      }
      const bundle = await writeMeetExportBundle({
        outputDir: options.output,
        artifacts,
        attendance,
        zip: Boolean(options.zip),
        request,
        tokenSource: resolveTokenSource(resolved.token.refreshed),
        ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
      });
      const payload = {
        ...bundle,
        ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
        tokenSource: resolveTokenSource(resolved.token.refreshed),
      };
      if (options.json) {
        writeStdoutJson(payload);
        return;
      }
      writeStdoutLine("export: %s", bundle.outputDir);
      for (const file of bundle.files) {
        writeStdoutLine("- %s", file);
      }
      if (bundle.zipFile) {
        writeStdoutLine("zip: %s", bundle.zipFile);
      }
    });
}
