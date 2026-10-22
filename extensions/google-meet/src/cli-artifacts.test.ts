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

const { run, output, json } = cli.useCli();
const runApiCommand = (command: string, args: string[] = []) =>
  run([command, "--access-token", "token", "--expires-at", String(Date.now() + 120_000), ...args]);

function runRecordCommand(command: string, args: string[] = []) {
  return runApiCommand(command, ["--conference-record", "rec-1", ...args]);
}

const bundleFiles = [
  "summary.md",
  "attendance.csv",
  "transcript.md",
  "artifacts.json",
  "attendance.json",
  "manifest.json",
];

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

it("prints artifacts and attendance output", async () => {
  await runRecordCommand("artifacts", ["--json"]);
  expect(json()).toMatchObject({
    tokenSource: "cached-access-token",
    conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
    artifacts: [
      {
        recordings: [{ name: "conferenceRecords/rec-1/recordings/r1" }],
        transcripts: [{ name: "conferenceRecords/rec-1/transcripts/t1" }],
        transcriptEntries: [
          {
            transcript: "conferenceRecords/rec-1/transcripts/t1",
            entries: [{ text: "Hello from the transcript." }],
          },
        ],
        smartNotes: [{ name: "conferenceRecords/rec-1/smartNotes/sn1" }],
      },
    ],
  });

  await runRecordCommand("attendance");
  expect(output()).toContain("attendance rows: 1");
  expect(output()).toContain("participant: Alice");
  expect(output()).toContain("conferenceRecords/rec-1/participants/p1/participantSessions/s1");
});

it("ends an active conference for a Meet space", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = cli.requestUrl(input);
    if (url.pathname === "/v2/spaces/abc-defg-hij") {
      return cli.jsonResponse({
        name: "spaces/space-resource-123",
        meetingCode: "abc-defg-hij",
        meetingUri: "https://meet.google.com/abc-defg-hij",
      });
    }
    if (url.pathname === "/v2/spaces/space-resource-123:endActiveConference") {
      return cli.jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await runApiCommand("end-active-conference", ["https://meet.google.com/abc-defg-hij", "--json"]);
  expect(json()).toMatchObject({
    space: "spaces/space-resource-123",
    ended: true,
    tokenSource: "cached-access-token",
  });
  const endCall = fetchMock.mock.calls.find(
    ([input]) =>
      input === "https://meet.googleapis.com/v2/spaces/space-resource-123:endActiveConference",
  );
  expect(endCall?.[1]).toEqual({
    method: "POST",
    body: "{}",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    },
  });
});

it("rejects access policy flags when create would use browser fallback", async () => {
  await expect(
    run(["create", "--access-type", "OPEN"], {
      runtime: {
        createViaBrowser: vi.fn(async () => {
          throw new Error("browser fallback should not run");
        }),
      },
    }),
  ).rejects.toThrow("access policy options require OAuth/API room creation");
});

it.each([
  [["--meeting", "abc-defg-hij"], "space: spaces/abc-defg-hij"],
  [["--today"], "calendar event: Project sync"],
] satisfies Array<[string[], string]>)(
  "prints the latest conference record for %j",
  async (args, expected) => {
    await runApiCommand("latest", args);
    expect(output()).toContain(expected);
    expect(output()).toContain("conference record: conferenceRecords/rec-1");
  },
);

it("prints calendar event previews", async () => {
  await runApiCommand("calendar-events", ["--today"]);
  expect(output()).toContain("meet events: 1");
  expect(output()).toContain("* Project sync");
  expect(output()).toContain("https://meet.google.com/abc-defg-hij");
});

it("rejects a fractional Meet API page size before fetching", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(runRecordCommand("artifacts", ["--page-size", "1.5"])).rejects.toThrow(
    "page-size must be a positive integer",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("prints markdown artifact and attendance output", async () => {
  const outputPath = path.join(tempDir, "artifacts.md");

  await runRecordCommand("artifacts", ["--format", "markdown", "--output", outputPath]);
  const markdown = readFileSync(outputPath, "utf8");
  expect(output()).toContain(`wrote: ${outputPath}`);
  expect(markdown).toContain("# Google Meet Artifacts");
  expect(markdown).toContain("## conferenceRecords/rec-1");
  expect(markdown).toContain("### Transcript Entries: conferenceRecords/rec-1/transcripts/t1");
  expect(markdown).toContain("Hello from the transcript.");

  await runRecordCommand("attendance", ["--format", "markdown"]);
  expect(output()).toContain("# Google Meet Attendance");
  expect(output()).toContain("## Alice");
  expect(output()).toContain("conferenceRecords/rec-1/participants/p1/participantSessions/s1");
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
  expect(readOutput("summary.md")).toContain("# Google Meet Artifacts");
  expect(readOutput("attendance.csv")).toContain("conferenceRecords/rec-1,Alice,users/alice");
  expect(readOutput("transcript.md")).toContain("Hello from the transcript.");
  expect(readOutput("transcript.md")).toContain("Transcript document body.");
  const manifest = JSON.parse(readOutput("manifest.json"));
  expect(manifest).toMatchObject({
    request: { conferenceRecord: "rec-1", includeDocumentBodies: true },
    tokenSource: "cached-access-token",
    counts: { attendanceRows: 1, warnings: 0 },
  });
  expect(manifest.files).toEqual(bundleFiles);
  expect(JSON.parse(readOutput("artifacts.json"))).toMatchObject({
    conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
    artifacts: [{ transcripts: [{ documentText: "Transcript document body." }] }],
  });
  const zip = await JSZip.loadAsync(readFileSync(`${tempDir}.zip`));
  expect(await zip.file("summary.md")?.async("string")).toContain("# Google Meet Artifacts");
});

it("includes artifact warnings in export summaries and manifests", async () => {
  cli.stubMeetArtifactsApi({ failSmartNoteDocumentBody: true });

  await runRecordCommand("export", ["--include-doc-bodies", "--output", tempDir, "--json"]);
  const summary = readOutput("summary.md");
  expect(summary).toContain("### Warnings");
  expect(summary).toContain("Document body warning");
  const manifest = JSON.parse(readOutput("manifest.json"));
  expect(manifest).toMatchObject({
    counts: { warnings: 1 },
    warnings: [
      {
        type: "smart_note_document_body",
        conferenceRecord: "conferenceRecords/rec-1",
        resource: "conferenceRecords/rec-1/smartNotes/sn1",
      },
    ],
  });
});

it("prints a dry-run export manifest without writing files", async () => {
  const outputDir = path.join(tempDir, "bundle");

  await runRecordCommand("export", ["--include-doc-bodies", "--output", outputDir, "--dry-run"]);
  const payload = JSON.parse(output());
  expect(payload).toMatchObject({
    dryRun: true,
    tokenSource: "cached-access-token",
    manifest: {
      request: { conferenceRecord: "rec-1", includeDocumentBodies: true },
      counts: { attendanceRows: 1, transcriptEntries: 1, warnings: 0 },
    },
  });
  expect(payload.manifest.files).toEqual(bundleFiles);
  expect(existsSync(outputDir)).toBe(false);
});
it("writes the artifact summary to --output", async () => {
  const outputPath = path.join(tempDir, "summary.txt");
  await runRecordCommand("artifacts", ["--format", "summary"]);
  const summary = output();
  expect(summary).toContain("conference records: 1\n");
  expect(summary).toContain("token source: cached-access-token\n");
  await runRecordCommand("artifacts", ["--format", "summary", "--output", outputPath]);
  expect(existsSync(outputPath)).toBe(true);
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
    const manifest = JSON.parse(
      readFileSync(path.join(publicationDir, "manifest.json"), "utf8"),
    ) as {
      zipFile?: string;
    };
    expect(result).toMatchObject({ outputDir: suppliedOutputDir, zipFile: zipPath });
    expect(manifest.zipFile).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);
    expect(existsSync(path.join(publicationDir, ".zip"))).toBe(false);
  },
);
