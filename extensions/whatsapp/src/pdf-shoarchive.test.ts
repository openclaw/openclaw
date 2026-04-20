import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveOutboundPdfToShoarchive,
  looksLikePdfArchiveCandidate,
  maybeShoarchiveOutboundPdf,
  registerCreatedPdfInShoarchive,
} from "./pdf-shoarchive.js";

const tempRoots: string[] = [];

async function makeWorkspaceRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shoarchive-test-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "creations", "pdfs"), { recursive: true });
  await fs.mkdir(path.join(root, "creations", "registry"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0, tempRoots.length).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("pdf shoarchive", () => {
  it("treats filename-based pdfs as archive candidates even with generic mime", () => {
    expect(
      looksLikePdfArchiveCandidate({
        mediaUrl: "/tmp/contract.pdf",
        contentType: "application/octet-stream",
        fileName: "contract.pdf",
      }),
    ).toBe(true);
    expect(
      looksLikePdfArchiveCandidate({
        mediaUrl: "/tmp/notes.txt",
        contentType: "application/octet-stream",
        fileName: "notes.txt",
      }),
    ).toBe(false);
  });

  it("copies an outbound pdf into creations and creates registry + index entries", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const sourceDir = path.join(workspaceRoot, "drafts");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePdf = path.join(sourceDir, "board-update-v1.pdf");
    const sourceHtml = path.join(sourceDir, "board-update-v1.html");
    await fs.writeFile(sourcePdf, "%PDF-1.4\nboard update\n", "utf8");
    await fs.writeFile(sourceHtml, "<html><body>board</body></html>", "utf8");

    const result = await archiveOutboundPdfToShoarchive({
      sourcePath: sourcePdf,
      recipient: "120363424903360682@g.us",
      via: "WhatsApp",
      workspaceRoot,
      deliveredAt: new Date("2026-04-09T12:00:00.000Z"),
      timezone: "Asia/Kolkata",
    });

    expect(path.relative(workspaceRoot, result.pdfPath)).toBe("creations/pdfs/board-update-v1.pdf");

    const indexContent = await fs.readFile(
      path.join(workspaceRoot, "creations", "INDEX.md"),
      "utf8",
    );
    expect(indexContent).toContain("| C001 | Board Update | pdf | archived |");
    expect(indexContent).toContain("pdfs/board-update-v1.pdf");

    const registryContent = await fs.readFile(result.registryPath, "utf8");
    expect(registryContent).toContain("**ID:** C001");
    expect(registryContent).toContain("`creations/pdfs/board-update-v1.pdf`");
    expect(registryContent).toContain("`creations/pdfs/board-update-v1.html`");
    expect(registryContent).toContain("120363424903360682@g.us");
  });

  it("updates an existing shoarchive entry instead of duplicating it", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const creationsRoot = path.join(workspaceRoot, "creations");
    const pdfPath = path.join(creationsRoot, "pdfs", "agreement-v1.pdf");
    const registryPath = path.join(creationsRoot, "registry", "agreement.md");
    const indexPath = path.join(creationsRoot, "INDEX.md");

    await fs.writeFile(pdfPath, "%PDF-1.4\nagreement\n", "utf8");
    await fs.writeFile(
      registryPath,
      `# Agreement

**ID:** C022
**Type:** PDF
**Status:** final
**Tags:** agreement, pdf
**Created:** 2026-04-08
**Last Modified:** 2026-04-08

## Files
- \`creations/pdfs/agreement-v1.pdf\`

## Delivery Log
| Date | Sent to | Via | File |
|------|---------|-----|------|
| 2026-04-08 | us-three | WhatsApp | \`creations/pdfs/agreement-v1.pdf\` |

## Notes
- Existing note.
`,
      "utf8",
    );
    await fs.writeFile(
      indexPath,
      `# Creation Registry Index

All files shoar creates for Kavish live here. One source of truth.

| ID | Name | Type | Status | Tags | Path | Last Modified |
|----|------|------|--------|------|------|---------------|
| C022 | Agreement | pdf | final | agreement, pdf | pdfs/agreement-v1.pdf | 2026-04-08 |
`,
      "utf8",
    );

    await maybeShoarchiveOutboundPdf({
      mediaUrl: pdfPath,
      contentType: "application/pdf",
      fileName: "agreement-v1.pdf",
      recipient: "us-three",
      via: "WhatsApp",
      workspaceRoot,
      deliveredAt: new Date("2026-04-09T19:16:36.000Z"),
      timezone: "Asia/Kolkata",
    });

    const registryContent = await fs.readFile(registryPath, "utf8");
    expect(registryContent).toContain("**Last Modified:** 2026-04-10");
    expect(registryContent).toContain(
      "| 2026-04-10 | us-three | WhatsApp | `creations/pdfs/agreement-v1.pdf` |",
    );

    const indexContent = await fs.readFile(indexPath, "utf8");
    expect(indexContent).toContain("| C022 | Agreement | pdf | final |");
    expect(indexContent).toContain("| pdfs/agreement-v1.pdf | 2026-04-10 |");
  });

  it("registers created pdfs before delivery using preserved render metadata", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const sourceDir = path.join(workspaceRoot, "creations", "pdfs");
    const sourcePdf = path.join(sourceDir, "memo-v1.pdf");
    const sourceHtml = path.join(sourceDir, "memo-v1.html");
    const processedHtml = path.join(sourceDir, "memo-v1.processed.html");
    const metadataPath = path.join(sourceDir, "memo-v1.meta.json");

    await fs.writeFile(sourcePdf, "%PDF-1.4\nmemo\n", "utf8");
    await fs.writeFile(sourceHtml, "<html><body>memo</body></html>", "utf8");
    await fs.writeFile(processedHtml, "<html><body>processed memo</body></html>", "utf8");
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          producer: "cookpdf.render",
          sourceHtml,
          processedHtml,
          renderCommand: `python3 ~/.openclaw/workspace/skills/cookpdf/scripts/render_pdf.py ${sourceHtml} ${sourcePdf}`,
          createdAt: "2026-04-10T00:50:00+05:30",
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await registerCreatedPdfInShoarchive({
      sourcePath: sourcePdf,
      workspaceRoot,
      createdAt: new Date("2026-04-10T00:50:00+05:30"),
      timezone: "Asia/Kolkata",
    });

    const registryContent = await fs.readFile(result.registryPath, "utf8");
    expect(registryContent).toContain("**Status:** registered");
    expect(registryContent).toContain(sourceHtml);
    expect(registryContent).toContain(processedHtml);
    expect(registryContent).toContain("render_pdf.py");

    const indexContent = await fs.readFile(
      path.join(workspaceRoot, "creations", "INDEX.md"),
      "utf8",
    );
    expect(indexContent).toContain("| C001 | Memo | pdf | registered |");
    expect(indexContent).toContain("| pdfs/memo-v1.pdf | 2026-04-10 |");
  });

  it("reuses legacy registry entries by path and preserves index identity", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const creationsRoot = path.join(workspaceRoot, "creations");
    const pdfPath = path.join(creationsRoot, "pdfs", "gopchar-brochure-v4.pdf");
    const registryPath = path.join(creationsRoot, "registry", "gopchar-brochure.md");
    const indexPath = path.join(creationsRoot, "INDEX.md");

    await fs.writeFile(pdfPath, "%PDF-1.4\nbrochure\n", "utf8");
    await fs.writeFile(
      registryPath,
      `# Gopchar Project Brochure

## Identity
- *created*: ~2026-02
- *last modified*: 2026-02-28
- *version*: 4
- *status*: draft (project ongoing)
- *file*: creations/pdfs/gopchar-brochure-v4.pdf
- *type*: pdf
- *tags*: gopchar, brochure, divine, print, real-estate
`,
      "utf8",
    );
    await fs.writeFile(
      indexPath,
      `# Creation Registry Index

All files shoar creates for Kavish live here. One source of truth.

| ID | Name | Type | Status | Tags | Path | Last Modified |
|----|------|------|--------|------|------|---------------|
| C001 | Gopchar Brochure | pdf | draft | gopchar, brochure, divine, print | pdfs/gopchar-brochure-v4.pdf | 2026-02-28 |
`,
      "utf8",
    );

    const result = await registerCreatedPdfInShoarchive({
      sourcePath: pdfPath,
      workspaceRoot,
      createdAt: new Date("2026-04-10T01:05:00+05:30"),
      timezone: "Asia/Kolkata",
    });

    expect(result.registryPath).toBe(registryPath);
    const updatedRegistry = await fs.readFile(registryPath, "utf8");
    expect(updatedRegistry).toContain("- *last modified*: 2026-04-10");

    const updatedIndex = await fs.readFile(indexPath, "utf8");
    expect(updatedIndex).toContain("| C001 | Gopchar Project Brochure | pdf | draft |");
    expect(updatedIndex).toContain("| pdfs/gopchar-brochure-v4.pdf | 2026-04-10 |");
  });

  it("ignores inbound-style pdf paths", async () => {
    const workspaceRoot = await makeWorkspaceRoot();
    const openclawRoot = path.dirname(workspaceRoot);
    const inboundDir = path.join(openclawRoot, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    const inboundPdf = path.join(inboundDir, "client-upload.pdf");
    await fs.writeFile(inboundPdf, "%PDF-1.4\nclient\n", "utf8");

    await maybeShoarchiveOutboundPdf({
      mediaUrl: inboundPdf,
      contentType: "application/pdf",
      recipient: "120363424903360682@g.us",
      workspaceRoot,
      deliveredAt: new Date("2026-04-09T09:00:00.000Z"),
    });

    await expect(
      fs.access(path.join(workspaceRoot, "creations", "INDEX.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
