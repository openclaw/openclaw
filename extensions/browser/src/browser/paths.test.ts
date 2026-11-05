import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExistingPathsWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pathFixture = vi.hoisted(() => ({ root: "" }));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => pathFixture.root,
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  get CONFIG_DIR() {
    return pathFixture.root;
  },
}));

async function createFixtureRoot() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-paths-"));
  const uploadsDir = path.join(baseDir, "uploads");
  const inboundMediaDir = path.join(baseDir, "media", "inbound");
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(inboundMediaDir, { recursive: true });
  return { baseDir, inboundMediaDir, uploadsDir };
}

let fixture: Awaited<ReturnType<typeof createFixtureRoot>>;
beforeEach(async () => {
  fixture = await createFixtureRoot();
});
afterEach(async () => {
  await fs.rm(fixture.baseDir, { recursive: true, force: true });
});

describe("resolveExistingPathsWithinRoot", () => {
  function expectInvalidResult(
    result: Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>,
    expectedSnippet: string,
  ) {
    expect(result).toEqual({ ok: false, error: expect.stringContaining(expectedSnippet) });
  }

  function resolveWithinUploads(requestedPath: string, uploadsDir = fixture.uploadsDir) {
    return resolveExistingPathsWithinRoot({
      rootDir: uploadsDir,
      requestedPaths: [requestedPath],
      scopeLabel: "uploads directory",
    });
  }

  it("rejects traversal outside the upload root", async () => {
    await writeFixtureFile(path.join(fixture.baseDir, "outside.txt"), "nope");
    expectInvalidResult(
      await resolveWithinUploads("../outside.txt"),
      "must stay within uploads directory",
    );
  });

  it("rejects directory paths inside upload root", async () => {
    await fs.mkdir(path.join(fixture.uploadsDir, "nested"), { recursive: true });
    expectInvalidResult(await resolveWithinUploads("nested"), "regular non-symlink file");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink escapes outside upload root",
    async () => {
      const { baseDir, uploadsDir } = fixture;
      const outsidePath = await writeFixtureFile(path.join(baseDir, "secret.txt"), "secret");
      await fs.symlink(outsidePath, path.join(uploadsDir, "leak.txt"));

      expectInvalidResult(await resolveWithinUploads("leak.txt"), "regular non-symlink file");
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns outside-root message for files reached via escaping symlinked directories",
    async () => {
      const { baseDir, uploadsDir } = fixture;
      const outsideDir = path.join(baseDir, "outside");
      await writeFixtureFile(path.join(outsideDir, "secret.txt"), "secret");
      await fs.symlink(outsideDir, path.join(uploadsDir, "alias"));

      expect(await resolveWithinUploads("alias/secret.txt")).toEqual({
        ok: false,
        error: "File is outside uploads directory",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects canonical absolute paths outside symlinked upload root",
    async () => {
      const { baseDir } = fixture;
      const canonicalUploadsDir = path.join(baseDir, "canonical", "uploads");
      const aliasedUploadsDir = path.join(baseDir, "uploads-link");
      await fs.mkdir(canonicalUploadsDir, { recursive: true });
      await fs.symlink(canonicalUploadsDir, aliasedUploadsDir);

      const outsideFile = await writeFixtureFile(
        path.join(baseDir, "outside/secret.txt"),
        "secret",
      );
      expectInvalidResult(
        await resolveWithinUploads(outsideFile, aliasedUploadsDir),
        "must stay within uploads directory",
      );
    },
  );
});

type FixtureRoot = Awaited<ReturnType<typeof createFixtureRoot>>;
type UploadPathResolver = "resolveExistingUploadPaths" | "resolveStrictExistingUploadPaths";
type UploadPathScenario =
  | "inbound-relative"
  | "mixed-relative"
  | `${"nested" | "traversal"}-uri`
  | "nested-absolute"
  | "outside"
  | "missing";
type UploadPathCase = readonly [string, UploadPathScenario, string?];
const directChild = "direct child of inbound media directory";
const nonSymlink = "regular non-symlink file";
const sandboxRelative = "sandbox-relative inbound media";

async function writeFixtureFile(filePath: string, contents: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return fs.realpath(filePath);
}

async function prepareUploadPathCase(
  { baseDir, inboundMediaDir, uploadsDir }: FixtureRoot,
  scenario: UploadPathScenario,
): Promise<{ requestedPaths: string[]; expectedPaths?: string[] }> {
  const inboundFile = path.join(inboundMediaDir, "report.pdf");
  if (scenario === "mixed-relative") {
    const uploadFile = path.join(uploadsDir, "from-upload.txt");
    const mixedInboundFile = path.join(inboundMediaDir, "from-inbound.txt");
    const expectedPaths = [
      await writeFixtureFile(uploadFile, "upload"),
      await writeFixtureFile(mixedInboundFile, "inbound"),
    ];
    return {
      requestedPaths: [uploadFile, "media/inbound/from-inbound.txt"],
      expectedPaths,
    };
  }
  const requestedPath = {
    "inbound-relative": "media/inbound/report.pdf",
    "nested-uri": "media://inbound/nested%2Fsecret.pdf",
    "traversal-uri": "media://inbound/nested/../report.pdf",
    "nested-absolute": path.join(inboundMediaDir, "nested", "secret.pdf"),
    outside: path.join(baseDir, "secret.txt"),
    missing: "missing.txt",
  }[scenario];
  if (scenario === "inbound-relative" || scenario === "traversal-uri") {
    await writeFixtureFile(inboundFile, "pdf");
  }
  if (scenario === "nested-absolute" || scenario === "outside") {
    await writeFixtureFile(requestedPath, "secret");
  }
  return {
    requestedPaths: [requestedPath],
    ...(scenario === "inbound-relative" ? { expectedPaths: [await fs.realpath(inboundFile)] } : {}),
  };
}

// Keep URI/root-precedence cases ordered across ingest and strict use-time validation.
function registerUploadPathCases(resolver: UploadPathResolver, cases: UploadPathCase[]) {
  for (const [title, scenario, expectedError] of cases) {
    it(title, async () => {
      pathFixture.root = fixture.baseDir;
      vi.resetModules();
      const resolve = (await import("./paths.js"))[resolver];
      const prepared = await prepareUploadPathCase(fixture, scenario);
      const result = await resolve({ requestedPaths: prepared.requestedPaths });
      if (expectedError) {
        expect(result).toEqual({ ok: false, error: expect.stringContaining(expectedError) });
        return;
      }
      expect(result).toEqual({ ok: true, paths: prepared.expectedPaths });
    });
  }
}

describe("resolveExistingUploadPaths", () => {
  registerUploadPathCases("resolveExistingUploadPaths", [
    [`falls back to ${sandboxRelative} paths after root validation`, "inbound-relative"],
    ["rejects nested inbound media URI references", "nested-uri", "Invalid media reference"],
    [
      "rejects traversal-shaped inbound media URI references before URL normalization",
      "traversal-uri",
      "Invalid media reference",
    ],
    ["rejects nested absolute inbound media paths", "nested-absolute", directChild],
    ["rejects files outside both managed upload roots", "outside", "inbound media directory"],
  ]);
});

describe("resolveStrictExistingUploadPaths", () => {
  registerUploadPathCases("resolveStrictExistingUploadPaths", [
    ["accepts mixed upload-root and inbound-media files at use time", "mixed-relative"],
    ["rejects files missing from both managed upload roots", "missing", nonSymlink],
  ]);
});
