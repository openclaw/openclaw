// Browser tests cover paths plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveExistingPathsWithinRoot,
  resolveExistingUploadPaths,
  resolveStrictExistingUploadPaths,
} from "./paths.js";

async function createFixtureRoot(): Promise<{
  baseDir: string;
  inboundMediaDir: string;
  uploadsDir: string;
}> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-paths-"));
  const uploadsDir = path.join(baseDir, "uploads");
  const inboundMediaDir = path.join(baseDir, "media", "inbound");
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(inboundMediaDir, { recursive: true });
  return { baseDir, inboundMediaDir, uploadsDir };
}

async function withFixtureRoot<T>(
  run: (ctx: { baseDir: string; inboundMediaDir: string; uploadsDir: string }) => Promise<T>,
): Promise<T> {
  const fixture = await createFixtureRoot();
  try {
    return await run(fixture);
  } finally {
    await fs.rm(fixture.baseDir, { recursive: true, force: true });
  }
}

async function createAliasedUploadsRoot(baseDir: string): Promise<{
  canonicalUploadsDir: string;
  aliasedUploadsDir: string;
}> {
  const canonicalUploadsDir = path.join(baseDir, "canonical", "uploads");
  const aliasedUploadsDir = path.join(baseDir, "uploads-link");
  await fs.mkdir(canonicalUploadsDir, { recursive: true });
  await fs.symlink(canonicalUploadsDir, aliasedUploadsDir);
  return { canonicalUploadsDir, aliasedUploadsDir };
}

describe("resolveExistingPathsWithinRoot", () => {
  function expectInvalidResult(
    result: Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>,
    expectedSnippet: string,
  ) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(expectedSnippet);
    }
  }

  function resolveWithinUploads(params: {
    uploadsDir: string;
    requestedPaths: string[];
  }): Promise<Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>> {
    return resolveExistingPathsWithinRoot({
      rootDir: params.uploadsDir,
      requestedPaths: params.requestedPaths,
      scopeLabel: "uploads directory",
    });
  }

  it("rejects traversal outside the upload root", async () => {
    await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
      const outsidePath = path.join(baseDir, "outside.txt");
      await fs.writeFile(outsidePath, "nope", "utf8");

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["../outside.txt"],
      });

      expectInvalidResult(result, "must stay within uploads directory");
    });
  });

  it("rejects directory paths inside upload root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const nestedDir = path.join(uploadsDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["nested"],
      });

      expectInvalidResult(result, "regular non-symlink file");
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink escapes outside upload root",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsidePath = path.join(baseDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");
        const symlinkPath = path.join(uploadsDir, "leak.txt");
        await fs.symlink(outsidePath, symlinkPath);

        const result = await resolveWithinUploads({
          uploadsDir,
          requestedPaths: ["leak.txt"],
        });

        expectInvalidResult(result, "regular non-symlink file");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns outside-root message for files reached via escaping symlinked directories",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsideDir = path.join(baseDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
        await fs.symlink(outsideDir, path.join(uploadsDir, "alias"));

        const result = await resolveWithinUploads({
          uploadsDir,
          requestedPaths: ["alias/secret.txt"],
        });

        expect(result).toEqual({
          ok: false,
          error: "File is outside uploads directory",
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects canonical absolute paths outside symlinked upload root",
    async () => {
      await withFixtureRoot(async ({ baseDir }) => {
        const { aliasedUploadsDir } = await createAliasedUploadsRoot(baseDir);

        const outsideDir = path.join(baseDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "secret", "utf8");

        const result = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [await fs.realpath(outsideFile)],
        });
        expectInvalidResult(result, "must stay within uploads directory");
      });
    },
  );
});

type FixtureRoot = Awaited<ReturnType<typeof createFixtureRoot>>;
type UploadPathResolver = typeof resolveExistingUploadPaths;
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
  async function prepareInboundPath(requestedPath: string) {
    const expectedPath = await writeFixtureFile(inboundFile, "pdf");
    return { requestedPaths: [requestedPath], expectedPaths: [expectedPath] };
  }
  if (scenario === "inbound-relative") {
    return prepareInboundPath("media/inbound/report.pdf");
  }
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
  if (scenario === "nested-uri") {
    return { requestedPaths: ["media://inbound/nested%2Fsecret.pdf"] };
  }
  if (scenario === "traversal-uri") {
    await writeFixtureFile(inboundFile, "pdf");
    return { requestedPaths: ["media://inbound/nested/../report.pdf"] };
  }
  if (scenario === "nested-absolute") {
    const nestedFile = path.join(inboundMediaDir, "nested", "secret.pdf");
    await writeFixtureFile(nestedFile, "secret");
    return { requestedPaths: [nestedFile] };
  }
  if (scenario === "outside") {
    const outsideFile = path.join(baseDir, "secret.txt");
    await writeFixtureFile(outsideFile, "secret");
    return { requestedPaths: [outsideFile] };
  }
  if (scenario === "missing") {
    return { requestedPaths: ["missing.txt"] };
  }
  scenario satisfies never;
  throw new Error("Unhandled upload path scenario");
}

// Keep URI/root-precedence cases ordered across ingest and strict use-time validation.
function registerUploadPathCases(resolver: UploadPathResolver, cases: UploadPathCase[]) {
  for (const [title, scenario, expectedError] of cases) {
    it(title, async () => {
      await withFixtureRoot(async (fixture) => {
        const prepared = await prepareUploadPathCase(fixture, scenario);
        const result = await resolver({
          uploadDir: fixture.uploadsDir,
          inboundMediaDir: fixture.inboundMediaDir,
          requestedPaths: prepared.requestedPaths,
        });
        if (expectedError) {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain(expectedError);
          }
          return;
        }
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.paths).toEqual(prepared.expectedPaths);
        }
      });
    });
  }
}

describe("resolveExistingUploadPaths", () => {
  registerUploadPathCases(resolveExistingUploadPaths, [
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
  registerUploadPathCases(resolveStrictExistingUploadPaths, [
    ["accepts mixed upload-root and inbound-media files at use time", "mixed-relative"],
    ["rejects files missing from both managed upload roots", "missing", nonSymlink],
  ]);
});
