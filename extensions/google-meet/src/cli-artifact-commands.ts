import {
  addGoogleMeetArtifactOptions,
  resolveCliParams,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
import {
  exportGoogleMeetBundle,
  renderArtifacts,
  renderAttendanceCsv,
  renderAttendance,
} from "./cli-export.js";
import {
  type MeetArtifactOptions,
  parseOptionalNumber,
  parsePositiveIntegerOption,
  writeCliOutput,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import {
  buildGoogleMeetExportRequest,
  fetchResolvedGoogleMeetArtifacts,
  fetchResolvedGoogleMeetAttendance,
  resolveArtifactQueryFromParams,
} from "./plugin-helpers.js";

async function resolveCliArtifactQuery(
  context: GoogleMeetCliCommandContext,
  options: MeetArtifactOptions,
) {
  const meeting = options.meeting?.trim() || context.config.defaults.meeting;
  const conferenceRecord = options.conferenceRecord?.trim();
  if (!meeting && !conferenceRecord && !(options.today || options.event?.trim())) {
    throw new Error(
      "Meeting input or conference record is required. Pass --meeting, --today, --event, --conference-record, or configure defaults.meeting.",
    );
  }
  const { lateAfterMinutes: late, earlyBeforeMinutes: early, ...queryOptions } = options;
  const raw = {
    ...resolveCliParams(queryOptions),
    meeting,
    conferenceRecord,
    pageSize: parsePositiveIntegerOption(options.pageSize, "page-size"),
    includeTranscriptEntries: options.transcriptEntries,
    includeAllConferenceRecords: options.allConferenceRecords,
    includeDocumentBodies: options.includeDocBodies,
    mergeDuplicateParticipants: options.mergeDuplicates,
  };
  const lateAfterMinutes = parseOptionalNumber(late);
  const earlyBeforeMinutes = parseOptionalNumber(early);
  return {
    ...(await resolveArtifactQueryFromParams(context.config, raw)),
    lateAfterMinutes,
    earlyBeforeMinutes,
  };
}

function resolveTokenSource(refreshed: boolean) {
  return refreshed ? "refresh-token" : "cached-access-token";
}

async function writeArtifactOutput<T>(
  options: MeetArtifactOptions,
  result: T,
  refreshed: boolean,
  render: (result: T, format: "summary" | "markdown") => string,
  csv?: (result: T) => string,
): Promise<void> {
  const tokenSource = resolveTokenSource(refreshed);
  let text: string;
  if (options.json) {
    text = JSON.stringify({ ...result, tokenSource }, null, 2);
  } else if (options.format === "markdown") {
    text = render(result, "markdown");
  } else if (options.format === "csv" && csv) {
    text = csv(result);
  } else if (!options.format || options.format === "summary") {
    text = `${render(result, "summary")}token source: ${tokenSource}\n`;
  } else {
    throw new Error(
      csv
        ? "Unsupported format. Expected summary, markdown, or csv."
        : "Unsupported format. Expected summary or markdown.",
    );
  }
  await writeCliOutput(options, text);
}

export function registerGoogleMeetArtifactCommands(context: GoogleMeetCliCommandContext): void {
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
      const resolved = await resolveCliArtifactQuery(context, options);
      const result = await fetchResolvedGoogleMeetArtifacts(resolved);
      await writeArtifactOutput(options, result, resolved.token.refreshed, renderArtifacts);
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
      const resolved = await resolveCliArtifactQuery(context, options);
      const result = await fetchResolvedGoogleMeetAttendance(resolved);
      await writeArtifactOutput(
        options,
        result,
        resolved.token.refreshed,
        renderAttendance,
        renderAttendanceCsv,
      );
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
      const resolved = await resolveCliArtifactQuery(context, options);
      const artifacts = await fetchResolvedGoogleMeetArtifacts(resolved);
      const attendance = await fetchResolvedGoogleMeetAttendance(resolved);
      const payload = await exportGoogleMeetBundle({
        outputDir: options.output,
        artifacts,
        attendance,
        zip: Boolean(options.zip),
        dryRun: options.dryRun,
        request: buildGoogleMeetExportRequest(resolved, options.calendar),
        tokenSource: resolveTokenSource(resolved.token.refreshed),
        calendarEvent: resolved.calendarEvent,
      });
      if (options.json || "dryRun" in payload) {
        writeStdoutJson(payload);
        return;
      }
      writeStdoutLine("export: %s", payload.outputDir);
      for (const file of payload.files) {
        writeStdoutLine("- %s", file);
      }
      if (payload.zipFile) {
        writeStdoutLine("zip: %s", payload.zipFile);
      }
    });
}
