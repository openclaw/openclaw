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

it("writes an export bundle", async () => {
  await runRecordCommand("export", ["--include-doc-bodies", "--zip", "--output", tempDir]);
  expect(output()).toContain(`export: ${tempDir}`);
  cli.expectText(
    readOutput("summary.md"),
    "# Google Meet Artifacts",
    `## ${record}`,
    `### Transcript Entries: ${transcript}`,
    "Hello from the transcript.",
  );
  expect(readOutput("attendance.csv")).toContain("conferenceRecords/rec-1,Alice,users/alice");
  cli.expectText(
    readOutput("transcript.md"),
    "Hello from the transcript.",
    "Transcript document body.",
  );
  const manifest = JSON.parse(readOutput("manifest.json"));
  expect(manifest).toMatchObject({
    request: { conferenceRecord: "rec-1", includeDocumentBodies: true },
    tokenSource: "cached-access-token",
    counts: { attendanceRows: 1, warnings: 0 },
  });
  expect(manifest.files.toSorted()).toEqual(readdirSync(tempDir).toSorted());
  expect(JSON.parse(readOutput("artifacts.json"))).toMatchObject({
    conferenceRecords: [{ name: record }],
    artifacts: [{ transcripts: [{ documentText: "Transcript document body." }] }],
  });
  const zip = await JSZip.loadAsync(readFileSync(`${tempDir}.zip`));
  expect(await zip.file("summary.md")?.async("string")).toContain("# Google Meet Artifacts");
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

it.each([
  { label: "repeated native", trailingSeparators: path.sep.repeat(2) },
  ...(process.platform === "win32"
    ? [
        { label: "repeated alternate", trailingSeparators: "//" },
        { label: "mixed", trailingSeparators: "\\/" },
      ]
    : []),
])(
  "writes the ZIP beside an output directory with $label trailing separators",
  async ({ trailingSeparators }) => {
    const suppliedOutputDir = `${publicationDir}${trailingSeparators}`;
    const zipPath = `${publicationDir}.zip`;
    const result = await writeBundle(suppliedOutputDir, true);
    const manifest = JSON.parse(readFileSync(path.join(publicationDir, "manifest.json"), "utf8"));
    expect(result).toMatchObject({ outputDir: suppliedOutputDir, zipFile: zipPath });
    expect(manifest.zipFile).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);
    expect(existsSync(path.join(publicationDir, ".zip"))).toBe(false);
  },
);
