import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeMeetExportBundle } from "./cli-export.js";
import * as cli from "./test-support/cli-harness.js";
import { MEET_URL } from "./test-support/fixtures.test-helpers.js";

const { run, output, json } = cli.useCli();
const runApiCommand = (command: string, args: string[] = []) =>
  run([command, "--access-token", "token", "--expires-at", String(Date.now() + 120_000), ...args]);

const runRecordCommand = (command: string, args: string[] = []) =>
  runApiCommand(command, ["--conference-record", "rec-1", ...args]);
const record = "conferenceRecords/rec-1";
const transcript = `${record}/transcripts/t1`;
const participantSession = `${record}/participants/p1/participantSessions/s1`;

let tempDir: string;
let publicationDir: string;
const readOutput = (name: string) => readFileSync(path.join(tempDir, name), "utf8");
beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-artifacts-"));
  publicationDir = path.join(tempDir, "bundle");
  cli.stubMeetArtifactsApi();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(`${tempDir}.zip`, { force: true });
});

it("prints artifact JSON", async () => {
  await runRecordCommand("artifacts", ["--json"]);
  expect(json()).toMatchObject({
    tokenSource: "cached-access-token",
    artifacts: [
      { transcriptEntries: [{ transcript, entries: [{ text: "Hello from the transcript." }] }] },
    ],
  });
});
it.each([
  ["summary", "attendance rows: 1", "participant: Alice"],
  ["markdown", "# Google Meet Attendance", "## Alice"],
])("prints %s attendance", async (format, heading, participant) => {
  await runRecordCommand("attendance", ["--format", format]);
  cli.expectText(output(), heading, participant, participantSession);
});

it.each([
  [["--meeting", "abc-defg-hij"], "space: spaces/abc-defg-hij"],
  [["--today"], "calendar event: Project sync"],
] satisfies Array<[string[], string]>)(
  "prints the latest conference record for %j",
  async (args, expected) => {
    await runApiCommand("latest", args);
    cli.expectText(output(), expected, `conference record: ${record}`);
  },
);

it("prints calendar event previews", async () => {
  await runApiCommand("calendar-events", ["--today"]);
  cli.expectText(output(), "meet events: 1", "* Project sync", MEET_URL);
});

function calendarListUrl(timeMin: Date, timeMax: Date, pageToken?: string) {
  const query = new URLSearchParams({
    maxResults: "50",
    orderBy: "startTime",
    showDeleted: "false",
    singleEvents: "true",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
  });
  if (pageToken) {
    query.set("pageToken", pageToken);
  }
  return `https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`;
}

it("selects the first current Meet when another event ends at the same instant", async () => {
  const noon = new Date(2026, 10, 25, 12);
  const at = (minutes: number) => ({
    dateTime: new Date(noon.getTime() + minutes * 60_000).toISOString(),
  });
  const ending = {
    start: at(-30),
    end: at(0),
    hangoutLink: "https://meet.google.com/aaa-aaaa-aaa",
  };
  const starting = { start: at(0), end: at(30), hangoutLink: MEET_URL };
  const tied = { ...starting, hangoutLink: "https://meet.google.com/ccc-cccc-ccc" };
  const events = [ending, starting, tied];
  const todayUrl = calendarListUrl(new Date(2026, 10, 25), new Date(2026, 10, 26));
  const defaultUrl = calendarListUrl(noon, new Date(2026, 11, 2, 12));
  const fetchMock = cli.stubJsonRoutes({
    [todayUrl]: { items: events },
    [defaultUrl]: { items: [starting, tied] },
  });

  vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(noon);
  try {
    for (const { args, visible } of [
      { args: ["--today"], visible: events },
      { args: [], visible: [starting, tied] },
    ]) {
      await runApiCommand("calendar-events", [...args, "--json"]);
      expect(json()).toMatchObject({
        events: visible.map(({ hangoutLink }) => ({
          meetingUri: hangoutLink,
          selected: hangoutLink === MEET_URL,
        })),
      });
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([todayUrl, defaultUrl]);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  // Local day has begun in Kiritimati and is still in progress in Los Angeles.
  ["Pacific/Kiritimati", "2024-02-28T10:00:15Z", "2024-02-29", "2024-03-01"],
  ["America/Los_Angeles", "2024-03-01T04:00:15Z", "2024-02-29", "2024-03-01"],
  // Equal future starts, including Havana's first occurrence of midnight.
  ["Pacific/Kiritimati", "2024-02-28T09:59:00Z", "2024-02-29", "2024-03-01"],
  ["America/Havana", "2024-11-03T03:59:00Z", "2024-11-03", "2024-11-04"],
  // Sep 7 ends when Santiago jumps directly to 01:00 on Sep 8.
  ["America/Santiago", "2024-09-08T03:58:00Z", "2024-09-07", "2024-09-08"],
  ["UTC", "2024-02-29T00:00:15Z", "2024-02-29", "2024-03-01"],
])("selects the all-day Meet in calendar zone %s at %s", async (timeZone, clock, start, end) => {
  const now = new Date(clock);
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  const allDay = {
    start: { date: start },
    end: { date: end },
    hangoutLink: MEET_URL,
  };
  const timed = {
    start: { dateTime: new Date(now.getTime() + 60_000).toISOString() },
    end: { dateTime: new Date(now.getTime() + 90_000).toISOString() },
    hangoutLink: "https://meet.google.com/bbb-bbbb-bbb",
  };
  cli.stubJsonRoutes({
    [calendarListUrl(now, week)]: { timeZone, items: [allDay], nextPageToken: "next" },
    [calendarListUrl(now, week, "next")]: { items: [timed] },
  });
  vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(now);
  try {
    await runApiCommand("calendar-events", ["--json"]);
    expect(json()).toMatchObject({
      events: [
        { event: allDay, meetingUri: MEET_URL, selected: true },
        { meetingUri: timed.hangoutLink, selected: false },
      ],
    });
  } finally {
    vi.useRealTimers();
  }
});

it("ends an active conference for a Meet space", async () => {
  const endUrl = "https://meet.googleapis.com/v2/spaces/space-resource-123:endActiveConference";
  const fetchMock = cli.stubJsonRoutes({
    "https://meet.googleapis.com/v2/spaces/abc-defg-hij": {
      name: "spaces/space-resource-123",
      meetingCode: "abc-defg-hij",
      meetingUri: MEET_URL,
    },
    [endUrl]: {},
  });
  await runApiCommand("end-active-conference", [MEET_URL, "--json"]);
  expect(json()).toMatchObject({
    space: "spaces/space-resource-123",
    ended: true,
    tokenSource: "cached-access-token",
  });
  const endCall = fetchMock.mock.calls.find(([input]) => input === endUrl);
  expect(endCall?.[1]).toMatchObject({
    method: "POST",
    redirect: "manual",
    headers: { Authorization: "Bearer token" },
  });
});

it("rejects access policy flags when create would use browser fallback", async () => {
  await expect(
    run(["create", "--access-type", "OPEN"], {
      runtime: {
        createViaBrowser: vi.fn().mockRejectedValue(new Error("browser fallback should not run")),
      },
    }),
  ).rejects.toThrow("access policy options require OAuth/API room creation");
});

it("rejects a fractional Meet API page size before fetching", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(runRecordCommand("artifacts", ["--page-size", "1.5"])).rejects.toThrow(
    "page-size must be a positive integer",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")(
  "preserves an existing output when the OS rejects a full write",
  () => {
    const outputPath = path.join(tempDir, "artifacts.md");
    const prior = "prior export\n";
    writeFileSync(outputPath, prior);
    chmodSync(outputPath, 0o640);

    const source = path.join(process.cwd(), "extensions/google-meet/src/cli-shared.ts");
    const script = `import { writeCliOutput } from ${JSON.stringify(source)}; await writeCliOutput({ output: process.env.OPENCLAW_TEST_OUTPUT }, "x".repeat(8192));`;
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'ulimit -f 1\nexec "$@"',
        "--",
        process.execPath,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_TEST_OUTPUT: outputPath },
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal === "SIGXFSZ" || result.stderr.includes("EFBIG")).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe(prior);
    expect(statSync(outputPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(tempDir)).toEqual(["artifacts.md"]);
  },
);

it("quotes carriage returns in formula-neutralized CSV cells", async () => {
  cli.stubMeetArtifactsApi({ participantDisplayName: "\r=1+1" });
  await runRecordCommand("attendance", ["--format", "csv"]);
  expect(output()).toContain('conferenceRecords/rec-1,"\'\r=1+1",users/alice');
});

it("writes an export bundle to the literal CLI output directory", async () => {
  const outputDir = path.join(tempDir, process.platform === "win32" ? "out" : "out ");
  const readBundleFile = (name: string) => readFileSync(path.join(outputDir, name), "utf8");
  const flags = ["--include-doc-bodies", "--no-transcript-entries", "--zip"];
  await runRecordCommand("export", [...flags, "--output", outputDir]);
  expect(output()).toContain(`export: ${outputDir}`);
  cli.expectText(
    readBundleFile("summary.md"),
    "# Google Meet Artifacts",
    `## ${record}`,
    "Transcript entries: 0",
  );
  expect(readBundleFile("attendance.csv")).toContain("conferenceRecords/rec-1,Alice,users/alice");
  cli.expectText(
    readBundleFile("transcript.md"),
    "_No transcript entries._",
    "Transcript document body.",
  );
  const manifest = JSON.parse(readBundleFile("manifest.json"));
  expect(manifest).toMatchObject({
    request: { conferenceRecord: "rec-1", includeDocumentBodies: true },
    tokenSource: "cached-access-token",
    counts: { attendanceRows: 1, warnings: 0 },
  });
  expect(manifest.files.toSorted()).toEqual(readdirSync(outputDir).toSorted());
  expect(JSON.parse(readBundleFile("artifacts.json"))).toMatchObject({
    conferenceRecords: [{ name: record }],
    artifacts: [{ transcripts: [{ documentText: "Transcript document body." }] }],
  });
  const zip = await JSZip.loadAsync(readFileSync(`${outputDir}.zip`));
  expect(await zip.file("summary.md")?.async("string")).toContain("# Google Meet Artifacts");
});

it("keeps namesakes distinct across a conference's transcript exports", async () => {
  const conference = (name: string, repeat: boolean) => {
    const first = `${name}/participants/p1`;
    const second = `${name}/participants/p2`;
    const entry = (id: string, text: string, participant?: string) => ({
      name: id,
      text,
      participant,
    });
    return {
      conferenceRecord: { name },
      recordings: [],
      transcripts: [],
      smartNotes: [],
      participants: [
        { name: second, anonymousUser: { displayName: "Sam" } },
        { name: first, signedinUser: { displayName: "Sam" } },
        { name: "phone", phoneUser: { displayName: "Caller" } },
      ],
      transcriptEntries: [
        { transcript: "first", entries: repeat ? [entry("a", "First commitment.", first)] : [] },
        {
          transcript: "next",
          entries: [
            entry("b", "Second commitment.", second),
            entry("c", "Phone remark.", "phone"),
            entry("d", "Missing roster entry.", "unlisted"),
            entry("e", "Unattributed."),
          ],
        },
      ],
    };
  };
  const records = [conference(record, true), conference("conferenceRecords/rec-2", false)];
  const artifacts = {
    conferenceRecords: records.map((entry) => entry.conferenceRecord),
    artifacts: records,
  };
  await writeMeetExportBundle({
    outputDir: tempDir,
    artifacts,
    attendance: { conferenceRecords: [], attendance: [] },
  });
  for (const file of ["summary.md", "transcript.md"]) {
    const [first, next] = readOutput(file).split("## conferenceRecords/rec-2");
    expect(first).toContain("Sam: First commitment.");
    expect(first).toContain("Sam (2): Second commitment.");
    expect(next).toContain("Sam: Second commitment.");
    expect(first).toContain("Caller: Phone remark.");
    expect(first).toContain("unlisted: Missing roster entry.");
    expect(first).toContain(file === "summary.md" ? "- Unattributed." : "- unknown: Unattributed.");
  }
  expect(JSON.parse(readOutput("artifacts.json"))).toEqual(artifacts);
});

it("includes artifact warnings in export summaries and manifests", async () => {
  cli.stubMeetArtifactsApi({ failSmartNoteDocumentBody: true });

  await runRecordCommand("export", ["--include-doc-bodies", "--output", tempDir, "--json"]);
  cli.expectText(readOutput("summary.md"), "### Warnings", "Document body warning");
  expect(JSON.parse(readOutput("manifest.json"))).toMatchObject({
    counts: { warnings: 1 },
    warnings: [
      {
        type: "smart_note_document_body",
        conferenceRecord: record,
        resource: `${record}/smartNotes/sn1`,
      },
    ],
  });
});

it("prints a dry-run export manifest without writing files", async () => {
  await runRecordCommand("export", [
    "--include-doc-bodies",
    "--output",
    publicationDir,
    "--dry-run",
  ]);
  const payload = JSON.parse(output());
  expect(payload).toMatchObject({
    dryRun: true,
    tokenSource: "cached-access-token",
    manifest: {
      request: { conferenceRecord: "rec-1", includeDocumentBodies: true },
      counts: { attendanceRows: 1, transcriptEntries: 1, warnings: 0 },
    },
  });
  expect(payload.manifest.files).toContain("manifest.json");
  expect(existsSync(publicationDir)).toBe(false);
});
it("writes the artifact summary to --output", async () => {
  const outputPath = path.join(tempDir, "summary.txt");
  await runRecordCommand("artifacts", ["--format", "summary"]);
  const summary = output();
  cli.expectText(summary, "conference records: 1\n", "token source: cached-access-token\n");
  await runRecordCommand("artifacts", ["--format", "summary", "--output", outputPath]);
  expect(readFileSync(outputPath, "utf8")).toBe(summary);
  expect(output()).toBe(`wrote: ${outputPath}\n`);
});

const writeBundle = (outputDir: string, zip = false) =>
  writeMeetExportBundle({
    outputDir,
    artifacts: { conferenceRecords: [], artifacts: [] },
    attendance: { conferenceRecords: [], attendance: [] },
    zip,
  });

it.each([false, true])(
  "preserves the existing file on failed replacement (zip=%s)",
  async (zip) => {
    const filePath = zip ? `${publicationDir}.zip` : path.join(publicationDir, "summary.md");
    const previous = zip
      ? await new JSZip()
          .file("previous.txt", "previous export")
          .generateAsync({ type: "nodebuffer" })
      : Buffer.from("previous summary\n");
    if (!zip) {
      mkdirSync(publicationDir);
    }
    writeFileSync(filePath, previous);
    const realWriteFile = fsp.writeFile;
    const write = vi.spyOn(fsp, "writeFile");
    write[zip ? "mockImplementation" : "mockImplementationOnce"](async (...args) => {
      const [file, data] = args;
      if (!zip || Buffer.isBuffer(data)) {
        expect(typeof file).toBe("string");
        writeFileSync(file as string, "partial replacement");
        throw new Error("injected write failure");
      }
      await Reflect.apply(realWriteFile, fsp, args);
    });
    await expect(writeBundle(publicationDir, zip)).rejects.toThrow("injected write failure");
    expect(readFileSync(filePath)).toEqual(previous);
    expect(readdirSync(zip ? tempDir : publicationDir).toSorted()).toEqual(
      zip ? ["bundle", "bundle.zip"] : ["summary.md"],
    );
  },
);

it.each([path.sep.repeat(2), ...(process.platform === "win32" ? ["//", "\\/"] : [" "])])(
  "preserves the literal output directory and writes its ZIP beside it (%j)",
  async (trailingSeparators) => {
    const suppliedOutputDir = `${publicationDir}${trailingSeparators}`;
    const directory = trailingSeparators === " " ? suppliedOutputDir : publicationDir;
    const zipPath = `${directory}.zip`;
    const result = await writeBundle(suppliedOutputDir, true);
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    expect(result).toMatchObject({ outputDir: suppliedOutputDir, zipFile: zipPath });
    expect(manifest.zipFile).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);
    expect(existsSync(path.join(directory, ".zip"))).toBe(false);
  },
);
