import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const shoarchiveLog = createSubsystemLogger("gateway/channels/whatsapp").child("shoarchive");
const MEDIA_PREFIX_RE = /^\s*MEDIA\s*:\s*/i;
const INDEX_HEADER = `# Creation Registry Index

All files shoar creates for Kavish live here. One source of truth.

| ID | Name | Type | Status | Tags | Path | Last Modified |
|----|------|------|--------|------|------|---------------|
`;

type MaybeShoarchiveOutboundPdfParams = {
  mediaUrl: string;
  contentType?: string;
  fileName?: string;
  recipient: string;
  via?: string;
  workspaceRoot?: string;
  deliveredAt?: Date;
  timezone?: string;
};

type ArchivePdfToShoarchiveParams = {
  sourcePath: string;
  contentType?: string;
  fileName?: string;
  recipient: string;
  via?: string;
  workspaceRoot: string;
  deliveredAt: Date;
  timezone?: string;
};

type RegisterCreatedPdfInShoarchiveParams = {
  sourcePath: string;
  contentType?: string;
  fileName?: string;
  workspaceRoot?: string;
  createdAt?: Date;
  timezone?: string;
  status?: string;
};

type ShoarchivePdfProvenance = {
  producer?: string;
  createdAt?: string;
  sourceUrl?: string;
  targetId?: string;
  sourceHtml?: string;
  processedHtml?: string;
  renderCommand?: string;
};

type ShoarchiveRegistryResult = {
  id: string;
  pdfPath: string;
  registryPath: string;
};

type ParsedRegistryMetadata = {
  id: string | null;
  title: string | null;
  type: string | null;
  status: string | null;
  tags: string[];
};

type ParsedIndexMetadata = {
  id: string | null;
  title: string | null;
  type: string | null;
  status: string | null;
  tags: string[];
};

type RegisterPdfToShoarchiveParams = {
  sourcePath: string;
  contentType?: string;
  fileName?: string;
  workspaceRoot: string;
  createdAt: Date;
  timezone?: string;
  status?: string;
  delivery?: {
    recipient: string;
    via: string;
    deliveredAt: Date;
  };
};

export async function maybeShoarchiveOutboundPdf(
  params: MaybeShoarchiveOutboundPdfParams,
): Promise<void> {
  const localPath = resolveLocalMediaPath(params.mediaUrl);
  if (!localPath) {
    return;
  }
  if (!isPdfLike({ path: localPath, contentType: params.contentType, fileName: params.fileName })) {
    return;
  }
  if (!isLikelyShoarCreatedPdf(localPath, params.workspaceRoot)) {
    return;
  }
  try {
    await archiveOutboundPdfToShoarchive({
      sourcePath: localPath,
      contentType: params.contentType,
      fileName: params.fileName,
      recipient: params.recipient,
      via: params.via,
      workspaceRoot: params.workspaceRoot ?? defaultWorkspaceRoot(),
      deliveredAt: params.deliveredAt ?? new Date(),
      timezone: params.timezone,
    });
  } catch (error) {
    shoarchiveLog.warn(
      `failed to shoarchive outbound pdf (${params.recipient}): ${String(error)} [${params.mediaUrl}]`,
    );
  }
}

export async function registerCreatedPdfInShoarchive(
  params: RegisterCreatedPdfInShoarchiveParams,
): Promise<ShoarchiveRegistryResult> {
  const createdAt = params.createdAt ?? (await resolveFileTimestamp(params.sourcePath));
  return await registerPdfToShoarchive({
    sourcePath: params.sourcePath,
    contentType: params.contentType,
    fileName: params.fileName,
    workspaceRoot: params.workspaceRoot ?? defaultWorkspaceRoot(),
    createdAt,
    timezone: params.timezone,
    status: params.status ?? "registered",
  });
}

export async function archiveOutboundPdfToShoarchive(
  params: ArchivePdfToShoarchiveParams,
): Promise<ShoarchiveRegistryResult> {
  return await registerPdfToShoarchive({
    sourcePath: params.sourcePath,
    contentType: params.contentType,
    fileName: params.fileName,
    workspaceRoot: params.workspaceRoot,
    createdAt: params.deliveredAt,
    timezone: params.timezone,
    status: "archived",
    delivery: {
      recipient: params.recipient,
      via: params.via ?? "WhatsApp",
      deliveredAt: params.deliveredAt,
    },
  });
}

async function registerPdfToShoarchive(
  params: RegisterPdfToShoarchiveParams,
): Promise<ShoarchiveRegistryResult> {
  const workspaceRoot = params.workspaceRoot;
  const creationsRoot = path.join(workspaceRoot, "creations");
  const pdfsDir = path.join(creationsRoot, "pdfs");
  const registryDir = path.join(creationsRoot, "registry");
  const indexPath = path.join(creationsRoot, "INDEX.md");

  await fs.mkdir(pdfsDir, { recursive: true });
  await fs.mkdir(registryDir, { recursive: true });
  await ensureIndexFile(indexPath);

  const createdDate = formatDate(params.createdAt, params.timezone);
  const modifiedDate = formatDate(
    params.delivery?.deliveredAt ?? params.createdAt,
    params.timezone,
  );
  const sourcePath = path.resolve(params.sourcePath);
  const sourceInsideCreations = isWithinPathInclusive(sourcePath, creationsRoot);
  const preferredName = sanitizeArchiveFileName(params.fileName ?? path.basename(sourcePath));
  const archivedPdfPath = sourceInsideCreations
    ? sourcePath
    : await copyIntoShoarchive({
        sourcePath,
        targetDir: pdfsDir,
        preferredName,
      });
  const archivedRelativePath = path.relative(creationsRoot, archivedPdfPath);
  const companionCopies = sourceInsideCreations
    ? await existingShoarchiveCompanions(archivedPdfPath)
    : await copyCompanionFiles({
        sourcePdfPath: sourcePath,
        archivedPdfPath,
      });
  const allRelativeFiles = [
    archivedRelativePath,
    ...companionCopies.map((filePath) => path.relative(creationsRoot, filePath)),
  ];

  const slug = slugFromFileName(path.basename(archivedPdfPath, path.extname(archivedPdfPath)));
  const indexContent = (await readIfExists(indexPath)) ?? INDEX_HEADER;
  const indexMetadata = parseIndexMetadata(indexContent, archivedRelativePath);
  const resolvedRegistry = await resolveExistingRegistry({
    registryDir,
    slug,
    archivedRelativePath,
  });
  const registryPath = resolvedRegistry.path;
  const existingRegistry = resolvedRegistry.content;
  const registryMetadata = parseRegistryMetadata(existingRegistry);
  const registryId = registryMetadata.id ?? indexMetadata.id ?? nextRegistryId(indexContent);
  const title = registryMetadata.title ?? indexMetadata.title ?? titleFromSlug(slug);
  const tags =
    registryMetadata.tags.length > 0
      ? registryMetadata.tags
      : indexMetadata.tags.length > 0
        ? indexMetadata.tags
        : inferTags(slug, archivedRelativePath);
  const typeLabel = registryMetadata.type ?? indexMetadata.type ?? "PDF";
  const status = registryMetadata.status ?? indexMetadata.status ?? params.status ?? "registered";
  const provenance = await readPdfProvenance(sourcePath);

  const registryContent = existingRegistry
    ? updateExistingRegistry({
        content: existingRegistry,
        createdDate,
        modifiedDate,
        typeLabel,
        status,
        tags,
        archivedRelativePath,
        sourcePath,
        allRelativeFiles,
        delivery: params.delivery
          ? {
              deliveredDate: modifiedDate,
              recipient: params.delivery.recipient,
              via: params.delivery.via,
            }
          : undefined,
      })
    : createRegistryEntry({
        id: registryId,
        title,
        createdDate,
        modifiedDate,
        typeLabel,
        status,
        archivedRelativePath,
        sourcePath,
        allRelativeFiles,
        tags,
        provenance,
        delivery: params.delivery
          ? {
              deliveredDate: modifiedDate,
              recipient: params.delivery.recipient,
              via: params.delivery.via,
            }
          : undefined,
      });

  await fs.writeFile(registryPath, registryContent, "utf8");
  await fs.writeFile(
    indexPath,
    updateIndex({
      indexContent,
      id: registryId,
      title,
      typeLabel,
      status,
      archivedRelativePath,
      deliveredDate: modifiedDate,
      tags,
    }),
    "utf8",
  );

  if (params.delivery) {
    shoarchiveLog.info(
      `shoarchived outbound pdf ${registryId} -> ${params.delivery.recipient} [${archivedPdfPath}]`,
    );
  } else {
    shoarchiveLog.info(`shoarchived created pdf ${registryId} [${archivedPdfPath}]`);
  }

  return {
    id: registryId,
    pdfPath: archivedPdfPath,
    registryPath,
  };
}

function defaultWorkspaceRoot(): string {
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function resolveLocalMediaPath(mediaUrl: string): string | null {
  let raw = mediaUrl.replace(MEDIA_PREFIX_RE, "").trim();
  raw = raw.replace(/^["'`]+|["'`]+$/g, "");
  if (!raw) {
    return null;
  }
  if (raw.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(raw));
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return null;
  }
  if (!path.isAbsolute(raw)) {
    return null;
  }
  return path.resolve(raw);
}

function isPdfLike(params: { path: string; contentType?: string; fileName?: string }): boolean {
  if (params.contentType?.trim().toLowerCase() === "application/pdf") {
    return true;
  }
  const fileName = (params.fileName ?? path.basename(params.path)).trim().toLowerCase();
  return fileName.endsWith(".pdf") || params.path.trim().toLowerCase().endsWith(".pdf");
}

export function looksLikePdfArchiveCandidate(params: {
  mediaUrl: string;
  contentType?: string;
  fileName?: string;
}): boolean {
  const pathHint =
    resolveLocalMediaPath(params.mediaUrl) ??
    params.mediaUrl
      .replace(MEDIA_PREFIX_RE, "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .split(/[?#]/, 1)[0];
  return isPdfLike({
    path: pathHint || params.mediaUrl,
    contentType: params.contentType,
    fileName: params.fileName,
  });
}

function isLikelyShoarCreatedPdf(filePath: string, workspaceRoot?: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot ?? defaultWorkspaceRoot());
  const openclawRoot = path.dirname(resolvedWorkspaceRoot);
  if (isWithinPathInclusive(resolvedPath, path.join(openclawRoot, "media", "inbound"))) {
    return false;
  }
  if (isWithinPathInclusive(resolvedPath, resolvedWorkspaceRoot)) {
    return true;
  }
  if (isWithinPathInclusive(resolvedPath, path.join(openclawRoot, "media", "browser"))) {
    return true;
  }
  if (isWithinPathInclusive(resolvedPath, path.join(openclawRoot, "agents"))) {
    return true;
  }
  return resolvedPath.startsWith(path.resolve(os.tmpdir()) + path.sep);
}

function isWithinPathInclusive(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function copyIntoShoarchive(params: {
  sourcePath: string;
  targetDir: string;
  preferredName: string;
}): Promise<string> {
  const initialTarget = path.join(params.targetDir, params.preferredName);
  const sourceHash = await fileHash(params.sourcePath);
  const existingHash = await safeFileHash(initialTarget);
  let targetPath = initialTarget;
  if (existingHash && existingHash !== sourceHash) {
    const parsed = path.parse(initialTarget);
    targetPath = path.join(
      parsed.dir,
      `${parsed.name}---${sourceHash.slice(0, 10)}${parsed.ext || ".pdf"}`,
    );
  }
  if (!(await fileExists(targetPath))) {
    await fs.copyFile(params.sourcePath, targetPath);
  }
  return targetPath;
}

async function copyCompanionFiles(params: {
  sourcePdfPath: string;
  archivedPdfPath: string;
}): Promise<string[]> {
  const copied: string[] = [];
  const targetDir = path.dirname(params.archivedPdfPath);
  for (const companion of companionCandidates(params.sourcePdfPath)) {
    if (!(await fileExists(companion.sourcePath))) {
      continue;
    }
    const archivedCompanion = path.join(targetDir, companion.fileName);
    if (!(await fileExists(archivedCompanion))) {
      await fs.copyFile(companion.sourcePath, archivedCompanion);
    }
    copied.push(archivedCompanion);
  }
  return copied;
}

async function existingShoarchiveCompanions(archivedPdfPath: string): Promise<string[]> {
  const existing: string[] = [];
  for (const companion of companionCandidates(archivedPdfPath)) {
    if (await fileExists(companion.sourcePath)) {
      existing.push(companion.sourcePath);
    }
  }
  return existing;
}

function companionCandidates(pdfPath: string): Array<{ sourcePath: string; fileName: string }> {
  const parsed = path.parse(pdfPath);
  const base = path.join(parsed.dir, parsed.name);
  return [
    `${base}.html`,
    `${base}.processed.html`,
    `${base}-preview.png`,
    `${base}.png`,
    `${base}.md`,
    `${base}.txt`,
    `${base}.docx`,
    `${base}.meta.json`,
  ].map((sourcePath) => ({ sourcePath, fileName: path.basename(sourcePath) }));
}

async function readPdfProvenance(sourcePdfPath: string): Promise<ShoarchivePdfProvenance | null> {
  const parsed = path.parse(sourcePdfPath);
  const metadataPath = path.join(parsed.dir, `${parsed.name}.meta.json`);
  const raw = await readIfExists(metadataPath);
  if (!raw) {
    return null;
  }
  try {
    const parsedJson = JSON.parse(raw) as Record<string, unknown>;
    return {
      createdAt: typeof parsedJson.createdAt === "string" ? parsedJson.createdAt : undefined,
      processedHtml:
        typeof parsedJson.processedHtml === "string" ? parsedJson.processedHtml : undefined,
      sourceUrl: typeof parsedJson.sourceUrl === "string" ? parsedJson.sourceUrl : undefined,
      sourceHtml: typeof parsedJson.sourceHtml === "string" ? parsedJson.sourceHtml : undefined,
      renderCommand:
        typeof parsedJson.renderCommand === "string" ? parsedJson.renderCommand : undefined,
      targetId: typeof parsedJson.targetId === "string" ? parsedJson.targetId : undefined,
      producer: typeof parsedJson.producer === "string" ? parsedJson.producer : undefined,
    };
  } catch {
    return null;
  }
}

async function ensureIndexFile(indexPath: string): Promise<void> {
  if (await fileExists(indexPath)) {
    return;
  }
  await fs.writeFile(indexPath, INDEX_HEADER, "utf8");
}

function parseRegistryId(content: string | null): string | null {
  return readRegistryField(content, "ID");
}

function parseRegistryTitle(content: string | null): string | null {
  const match = content?.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function parseRegistryMetadata(content: string | null): ParsedRegistryMetadata {
  return {
    id: parseRegistryId(content),
    title: parseRegistryTitle(content),
    type: readRegistryField(content, "Type"),
    status: readRegistryField(content, "Status"),
    tags: parseTagsField(readRegistryField(content, "Tags")),
  };
}

function parseIndexMetadata(
  indexContent: string,
  archivedRelativePath: string,
): ParsedIndexMetadata {
  for (const line of indexContent.split("\n")) {
    if (!line.startsWith("| C")) {
      continue;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 8) {
      continue;
    }
    const [, id, title, type, status, tags, relativePath] = cells;
    if (relativePath !== archivedRelativePath) {
      continue;
    }
    return {
      id: id || null,
      title: title || null,
      type: type || null,
      status: status || null,
      tags: parseTagsField(tags || null),
    };
  }
  return {
    id: null,
    title: null,
    type: null,
    status: null,
    tags: [],
  };
}

function nextRegistryId(indexContent: string): string {
  const matches = [...indexContent.matchAll(/\|\s*(C\d+)\s*\|/g)];
  const maxValue = matches.reduce((max, match) => {
    const value = Number.parseInt(match[1]?.slice(1) ?? "0", 10);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
  return `C${String(maxValue + 1).padStart(3, "0")}`;
}

function slugFromFileName(fileName: string): string {
  return fileName
    .trim()
    .toLowerCase()
    .replace(/---[a-f0-9]{8,}$/i, "")
    .replace(/-v\d+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferTags(slug: string, archivedRelativePath: string): string[] {
  const tags = new Set(
    slug
      .split("-")
      .filter(Boolean)
      .filter((part) => part.length > 1),
  );
  tags.add("pdf");
  tags.add("whatsapp");
  if (archivedRelativePath.startsWith("pdfs/")) {
    tags.add("shoarchive");
  }
  return [...tags];
}

function createRegistryEntry(params: {
  id: string;
  title: string;
  createdDate: string;
  modifiedDate: string;
  typeLabel: string;
  status: string;
  archivedRelativePath: string;
  sourcePath: string;
  allRelativeFiles: string[];
  tags: string[];
  provenance: ShoarchivePdfProvenance | null;
  delivery?:
    | {
        deliveredDate: string;
        recipient: string;
        via: string;
      }
    | undefined;
}): string {
  const hasCookPdfRecipe = Boolean(
    params.provenance?.sourceHtml || params.provenance?.renderCommand,
  );
  const recipeLines = [`1. Original outbound PDF path: \`${params.sourcePath}\`.`];
  if (hasCookPdfRecipe) {
    if (params.provenance?.sourceHtml) {
      recipeLines.push(`2. Source HTML preserved at \`${params.provenance.sourceHtml}\`.`);
    }
    if (params.provenance?.processedHtml) {
      recipeLines.push(
        `3. Processed print HTML preserved at \`${params.provenance.processedHtml}\`.`,
      );
    }
    if (params.provenance?.renderCommand) {
      recipeLines.push(`4. Render command: \`${params.provenance.renderCommand}\`.`);
    }
  } else if (params.provenance?.sourceUrl) {
    recipeLines.push(
      `2. Browser provenance preserved with source URL \`${params.provenance.sourceUrl}\`; recreate by reopening that page and exporting PDF again before applying edits.`,
    );
    if (params.provenance?.targetId) {
      recipeLines.push(`3. Browser target id at capture time: \`${params.provenance.targetId}\`.`);
    }
  } else {
    recipeLines.push(
      `2. PDF was auto-registered into \`creations/${params.archivedRelativePath}\` so the file stays recallable in shoarchive.`,
    );
  }
  if (params.delivery) {
    recipeLines.push(
      `${recipeLines.length + 1}. Delivery was recorded on ${params.delivery.deliveredDate} to ${params.delivery.recipient} via ${params.delivery.via}.`,
    );
  }

  const dataSourceLines = [
    `- Original file path: \`${params.sourcePath}\``,
    ...params.allRelativeFiles
      .filter((entry) => entry !== params.archivedRelativePath)
      .map((entry) => `- Preserved companion: \`creations/${entry}\``),
  ];
  if (params.provenance?.sourceUrl) {
    dataSourceLines.push(`- Browser source URL: \`${params.provenance.sourceUrl}\``);
  }
  if (params.provenance?.sourceHtml) {
    dataSourceLines.push(`- Source HTML: \`${params.provenance.sourceHtml}\``);
  }

  const dependencyLines = hasCookPdfRecipe
    ? [
        "- `~/.openclaw/workspace/skills/cookpdf/scripts/render_pdf.py`",
        "- Puppeteer or Chrome headless renderer",
      ]
    : params.provenance?.producer
      ? [`- ${params.provenance.producer}`]
      : ["- Auto-archived on WhatsApp send; original renderer not captured"];

  return `# ${params.title}

**ID:** ${params.id}
**Type:** ${params.typeLabel}
**Status:** ${params.status}
**Tags:** ${params.tags.join(", ")}
**Created:** ${params.createdDate}
**Last Modified:** ${params.modifiedDate}

## Files
${params.allRelativeFiles.map((entry) => `- \`creations/${entry}\``).join("\n")}

## Request
Auto-registered from a Shoar PDF creation or delivery event so the file stays editable and recallable in shoarchive.

## Recipe
${recipeLines.join("\n")}

## Design Specs
- *dimensions*: unknown (auto-archived)
- *fonts*: unknown (auto-archived)
- *colors*: unknown (auto-archived)
- *layout*: preserve current PDF; inspect preserved source companion files for editable structure
- *special*: outbound WhatsApp archive hook attached provenance and delivery details

## Data Sources
${dataSourceLines.join("\n")}

## Dependencies
${dependencyLines.join("\n")}

## Delivery Log
| Date | Sent to | Via | File |
|------|---------|-----|------|
${params.delivery ? `| ${params.delivery.deliveredDate} | ${params.delivery.recipient} | ${params.delivery.via} | \`creations/${params.archivedRelativePath}\` |` : ""}

## Version History
| Ver | Date | Changes |
|-----|------|---------|
| auto-v1 | ${params.modifiedDate} | Auto-registered into shoarchive |

## Notes
- This registry entry was created automatically by the Shoarchive PDF protocol.
- If you revise the PDF later, preserve the old file and bump the version in-place.
`;
}

function updateExistingRegistry(params: {
  content: string;
  createdDate: string;
  modifiedDate: string;
  typeLabel: string;
  status: string;
  tags: string[];
  archivedRelativePath: string;
  sourcePath: string;
  allRelativeFiles: string[];
  delivery?:
    | {
        deliveredDate: string;
        recipient: string;
        via: string;
      }
    | undefined;
}): string {
  let content = ensureSimpleField(params.content, "Created", params.createdDate);
  content = upsertSimpleField(content, "Last Modified", params.modifiedDate);
  content = ensureSimpleField(content, "Type", params.typeLabel);
  content = ensureSimpleField(content, "Status", params.status);
  content = ensureSimpleField(content, "Tags", params.tags.join(", "));
  content = upsertFilesSection(content, params.allRelativeFiles);
  if (params.delivery) {
    content = upsertDeliveryLog(content, {
      deliveredDate: params.delivery.deliveredDate,
      recipient: params.delivery.recipient,
      via: params.delivery.via,
      archivedRelativePath: params.archivedRelativePath,
    });
    content = appendNote(
      content,
      `- Auto-archived outbound WhatsApp send on ${params.delivery.deliveredDate} from \`${params.sourcePath}\`.`,
    );
  }
  return content;
}

function upsertSimpleField(content: string, label: string, value: string): string {
  const pattern = new RegExp(`\\*\\*${escapeForRegex(label)}:\\*\\*\\s*.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `**${label}:** ${value}`);
  }
  const legacyLabel = label.toLowerCase();
  const legacyPattern = new RegExp(`^-\\s*\\*${escapeForRegex(legacyLabel)}\\*:\\s*.*$`, "im");
  if (legacyPattern.test(content)) {
    return content.replace(legacyPattern, `- *${legacyLabel}*: ${value}`);
  }
  return `${content.trimEnd()}\n**${label}:** ${value}\n`;
}

function ensureSimpleField(content: string, label: string, value: string): string {
  return readRegistryField(content, label) ? content : upsertSimpleField(content, label, value);
}

function upsertFilesSection(content: string, relativeFiles: string[]): string {
  const existingSection = readSection(content, "Files");
  const wantedLines = relativeFiles.map((entry) => `- \`creations/${entry}\``);
  const mergedLines = existingSection
    ? mergeUniqueLines(splitSectionLines(existingSection), wantedLines)
    : wantedLines;
  return upsertSection(content, "Files", `${mergedLines.join("\n")}\n`);
}

function upsertDeliveryLog(
  content: string,
  params: {
    deliveredDate: string;
    recipient: string;
    via: string;
    archivedRelativePath: string;
  },
): string {
  const row = `| ${params.deliveredDate} | ${params.recipient} | ${params.via} | \`creations/${params.archivedRelativePath}\` |`;
  const existingSection = readSection(content, "Delivery Log");
  if (!existingSection) {
    return upsertSection(
      content,
      "Delivery Log",
      `| Date | Sent to | Via | File |
|------|---------|-----|------|
${row}
`,
    );
  }
  const lines = splitSectionLines(existingSection);
  if (!lines.includes("| Date | Sent to | Via | File |")) {
    lines.unshift("| Date | Sent to | Via | File |", "|------|---------|-----|------|");
  }
  if (!lines.includes(row)) {
    lines.push(row);
  }
  return upsertSection(content, "Delivery Log", `${lines.join("\n")}\n`);
}

function appendNote(content: string, noteLine: string): string {
  const existingSection = readSection(content, "Notes");
  if (!existingSection) {
    return upsertSection(content, "Notes", `${noteLine}\n`);
  }
  const lines = splitSectionLines(existingSection);
  if (!lines.includes(noteLine)) {
    lines.push(noteLine);
  }
  return upsertSection(content, "Notes", `${lines.join("\n")}\n`);
}

function readSection(content: string, heading: string): string | null {
  const match = content.match(
    new RegExp(`## ${escapeForRegex(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`),
  );
  return match?.[1]?.trimEnd() ?? null;
}

function upsertSection(content: string, heading: string, body: string): string {
  const normalizedBody = body.trimEnd();
  const pattern = new RegExp(`## ${escapeForRegex(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`);
  if (pattern.test(content)) {
    return content.replace(pattern, `## ${heading}\n${normalizedBody}\n`);
  }
  return `${content.trimEnd()}\n\n## ${heading}\n${normalizedBody}\n`;
}

function splitSectionLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function mergeUniqueLines(existing: string[], wanted: string[]): string[] {
  const merged = [...existing];
  for (const line of wanted) {
    if (!merged.includes(line)) {
      merged.push(line);
    }
  }
  return merged;
}

function updateIndex(params: {
  indexContent: string;
  id: string;
  title: string;
  typeLabel: string;
  status: string;
  archivedRelativePath: string;
  deliveredDate: string;
  tags: string[];
}): string {
  const row = `| ${params.id} | ${params.title} | ${normalizeIndexType(params.typeLabel)} | ${normalizeIndexStatus(params.status)} | ${params.tags.join(", ")} | ${params.archivedRelativePath} | ${params.deliveredDate} |`;
  const lines = params.indexContent.trimEnd().split("\n");
  const rowIndex = lines.findIndex(
    (line) =>
      line.startsWith(`| ${params.id} |`) || line.includes(`| ${params.archivedRelativePath} |`),
  );
  if (rowIndex >= 0) {
    lines[rowIndex] = row;
  } else {
    lines.push(row);
  }
  return `${lines.join("\n")}\n`;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function safeFileHash(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return await fileHash(filePath);
}

async function fileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeArchiveFileName(fileName: string): string {
  const trimmed = fileName.trim() || "document.pdf";
  const sanitized = trimmed.replace(/[^\w.-]+/g, "-");
  return sanitized.toLowerCase().endsWith(".pdf") ? sanitized : `${sanitized}.pdf`;
}

function formatDate(date: Date, timeZone?: string): string {
  const resolvedTimeZone =
    timeZone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!resolvedTimeZone) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolvedTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? String(date.getFullYear());
  const month =
    parts.find((part) => part.type === "month")?.value ??
    String(date.getMonth() + 1).padStart(2, "0");
  const day =
    parts.find((part) => part.type === "day")?.value ?? String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTagsField(value: string | null): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function readRegistryField(content: string | null, label: string): string | null {
  if (!content) {
    return null;
  }
  const modernPattern = new RegExp(`\\*\\*${escapeForRegex(label)}:\\*\\*\\s*(.+)$`, "mi");
  const modernMatch = content.match(modernPattern);
  if (modernMatch?.[1]) {
    return modernMatch[1].trim();
  }
  const legacyLabel = label.toLowerCase();
  const legacyPattern = new RegExp(`^-\\s*\\*${escapeForRegex(legacyLabel)}\\*:\\s*(.+)$`, "mi");
  const legacyMatch = content.match(legacyPattern);
  return legacyMatch?.[1]?.trim() ?? null;
}

function normalizeIndexType(typeLabel: string): string {
  const normalized = typeLabel.trim().toLowerCase();
  if (normalized.includes("card") && normalized.includes("pdf")) {
    return "card/pdf";
  }
  if (normalized.includes("pdf")) {
    return "pdf";
  }
  return normalized || "pdf";
}

function normalizeIndexStatus(status: string): string {
  const normalized = status.trim();
  const base = normalized.split("(", 1)[0]?.trim();
  return base || "registered";
}

async function resolveFileTimestamp(filePath: string): Promise<Date> {
  const stats = await fs.stat(filePath);
  return stats.mtime;
}

async function resolveExistingRegistry(params: {
  registryDir: string;
  slug: string;
  archivedRelativePath: string;
}): Promise<{ path: string; content: string | null }> {
  const directPath = path.join(params.registryDir, `${params.slug}.md`);
  const directContent = await readIfExists(directPath);
  if (directContent) {
    return { path: directPath, content: directContent };
  }
  const basename = path.basename(params.archivedRelativePath);
  for (const entry of await fs.readdir(params.registryDir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const candidatePath = path.join(params.registryDir, entry);
    const candidateContent = await readIfExists(candidatePath);
    if (!candidateContent) {
      continue;
    }
    if (
      candidateContent.includes(`creations/${params.archivedRelativePath}`) ||
      candidateContent.includes(params.archivedRelativePath) ||
      candidateContent.includes(basename)
    ) {
      return { path: candidatePath, content: candidateContent };
    }
  }
  return { path: directPath, content: null };
}
