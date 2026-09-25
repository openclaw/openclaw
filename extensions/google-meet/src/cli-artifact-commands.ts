import {
  addGoogleMeetArtifactOptions,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
import {
  exportGoogleMeetBundle,
  renderArtifactsMarkdown,
  renderArtifactsSummary,
  renderAttendanceCsv,
  renderAttendanceMarkdown,
  renderAttendanceSummary,
} from "./cli-export.js";
import {
  type MeetArtifactOptions,
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
