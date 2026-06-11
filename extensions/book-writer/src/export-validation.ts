import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GateFinding, GateReport } from "./types.js";

type CommandResult = {
  code: number;
  stdout: Buffer;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export type PublishingExportValidationOptions = {
  epubPath: string;
  printHtmlPath: string;
  printPdfPath: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
};

export type PublishingExportValidationResult = {
  report: GateReport;
  printPdfPath?: string;
};

const EPUBCHECK_TIMEOUT_MS = 2 * 60 * 1000;
const PDF_EXPORT_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_PRINT_MARGIN_IN = 0.5;
const MAX_STDERR_CHARS = 400;
const PDF_PAGE_WIDTH = 432;
const PDF_PAGE_HEIGHT = 648;
const PDF_MARGIN = 54;
const PDF_FONT_SIZE = 11;
const PDF_LINE_HEIGHT = 16;

function statusFromFindings(findings: GateFinding[]): GateReport["status"] {
  if (findings.some((finding) => finding.status === "blocked")) {
    return "blocked";
  }
  if (findings.some((finding) => finding.status === "fail")) {
    return "fail";
  }
  if (findings.some((finding) => finding.status === "warn")) {
    return "warn";
  }
  return "pass";
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: options.env,
        maxBuffer: 20 * 1024 * 1024,
        timeout: options.timeoutMs,
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        const maybeCode =
          error && "code" in error && typeof error.code === "number" ? error.code : 0;
        resolve({
          code: error ? maybeCode || 1 : 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr)
            ? stderr.toString("utf8")
            : typeof stderr === "string"
              ? stderr
              : "",
        });
      },
    );
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  extraCandidates: string[] = [],
): Promise<string | undefined> {
  if (path.isAbsolute(name) && (await pathExists(name))) {
    return name;
  }
  const candidates = [
    ...extraCandidates,
    ...(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, name)),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function trimMessage(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_STDERR_CHARS ? `${trimmed.slice(0, MAX_STDERR_CHARS)}...` : trimmed;
}

async function validateWithEpubCheck(
  epubPath: string,
  env: NodeJS.ProcessEnv,
  commandRunner: CommandRunner,
): Promise<GateFinding> {
  const configuredBin = env.OPENCLAW_BOOK_WRITER_EPUBCHECK_BIN;
  const configuredJar = env.OPENCLAW_BOOK_WRITER_EPUBCHECK_JAR ?? env.EPUBCHECK_JAR;
  if (configuredJar && (await pathExists(configuredJar))) {
    const java = await findExecutable("java", env, ["/usr/bin/java"]);
    if (!java) {
      return {
        code: "epubcheck",
        status: "warn",
        message: "EPUBCheck jar is configured, but Java is unavailable.",
      };
    }
    const result = await commandRunner(java, ["-jar", configuredJar, epubPath], {
      timeoutMs: EPUBCHECK_TIMEOUT_MS,
      env,
    });
    return {
      code: "epubcheck",
      status: result.code === 0 ? "pass" : "fail",
      message:
        result.code === 0
          ? "Official EPUBCheck completed successfully."
          : `Official EPUBCheck failed: ${trimMessage(result.stderr) || "no diagnostic output"}.`,
    };
  }

  const epubcheck = configuredBin
    ? await findExecutable(configuredBin, env)
    : await findExecutable("epubcheck", env);
  if (!epubcheck) {
    return {
      code: "epubcheck",
      status: "warn",
      message:
        "Official EPUBCheck is unavailable; set OPENCLAW_BOOK_WRITER_EPUBCHECK_BIN or OPENCLAW_BOOK_WRITER_EPUBCHECK_JAR to enable the upload-grade EPUB gate.",
    };
  }
  const result = await commandRunner(epubcheck, [epubPath], {
    timeoutMs: EPUBCHECK_TIMEOUT_MS,
    env,
  });
  return {
    code: "epubcheck",
    status: result.code === 0 ? "pass" : "fail",
    message:
      result.code === 0
        ? "Official EPUBCheck completed successfully."
        : `Official EPUBCheck failed: ${trimMessage(result.stderr) || "no diagnostic output"}.`,
  };
}

function validatePrintHtml(html: string): GateFinding[] {
  const pageRule = /@page\s*\{(?<body>[^}]+)\}/i.exec(html)?.groups?.body ?? "";
  const sizeMatch = /\bsize\s*:\s*(?<width>\d+(?:\.\d+)?)in\s+(?<height>\d+(?:\.\d+)?)in\b/i.exec(
    pageRule,
  );
  const marginMatch = /\bmargin\s*:\s*(?<margin>\d+(?:\.\d+)?)in\b/i.exec(pageRule);
  const width = sizeMatch?.groups?.width ? Number(sizeMatch.groups.width) : 0;
  const height = sizeMatch?.groups?.height ? Number(sizeMatch.groups.height) : 0;
  const margin = marginMatch?.groups?.margin ? Number(marginMatch.groups.margin) : 0;
  return [
    {
      code: "print-html-document",
      status:
        /<!doctype html>/i.test(html) && /<meta charset="utf-8"/i.test(html) ? "pass" : "fail",
      message: "Print HTML document declaration and UTF-8 metadata checked.",
    },
    {
      code: "print-trim-size",
      status: width === 6 && height === 9 ? "pass" : "fail",
      score: width && height ? width * height : undefined,
      message:
        width === 6 && height === 9
          ? "Print trim size is 6in x 9in."
          : "Print trim size must be declared as 6in x 9in.",
    },
    {
      code: "print-margin",
      status: margin >= MIN_PRINT_MARGIN_IN ? "pass" : "fail",
      score: margin || undefined,
      message:
        margin >= MIN_PRINT_MARGIN_IN
          ? `Print margin is ${margin}in.`
          : `Print margin must be at least ${MIN_PRINT_MARGIN_IN}in.`,
    },
    {
      code: "print-content-flow",
      status:
        /<h1>.+<\/h1>/i.test(html) && /<h2>.+<\/h2>/i.test(html) && /<p>.+<\/p>/i.test(html)
          ? "pass"
          : "fail",
      message: "Print HTML contains title, chapter headings, and body paragraphs.",
    },
  ];
}

async function validatePdfHeader(filePath: string): Promise<boolean> {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.length > 1024 && buffer.subarray(0, 4).toString("latin1") === "%PDF";
  } catch {
    return false;
  }
}

async function exportPdfWithCupsFilter(params: {
  printHtmlPath: string;
  printPdfPath: string;
  env: NodeJS.ProcessEnv;
  commandRunner: CommandRunner;
}): Promise<GateFinding | undefined> {
  const cupsfilter = await findExecutable("cupsfilter", params.env, ["/usr/sbin/cupsfilter"]);
  if (!cupsfilter) {
    return undefined;
  }
  const result = await params.commandRunner(
    cupsfilter,
    ["-m", "application/pdf", params.printHtmlPath],
    {
      timeoutMs: PDF_EXPORT_TIMEOUT_MS,
      env: params.env,
    },
  );
  if (result.code !== 0 || result.stdout.length === 0) {
    return {
      code: "print-pdf-export",
      status: "warn",
      message: `cupsfilter PDF export failed: ${trimMessage(result.stderr) || "no diagnostic output"}.`,
    };
  }
  await fs.writeFile(params.printPdfPath, result.stdout);
  const valid = await validatePdfHeader(params.printPdfPath);
  return {
    code: "print-pdf-export",
    status: valid ? "pass" : "warn",
    message: valid
      ? "Print PDF exported with cupsfilter."
      : "cupsfilter did not produce a valid PDF.",
  };
}

async function exportPdfWithChromium(params: {
  printHtmlPath: string;
  printPdfPath: string;
  env: NodeJS.ProcessEnv;
  commandRunner: CommandRunner;
}): Promise<GateFinding | undefined> {
  const chromium = await findExecutable(
    "chromium",
    params.env,
    [
      params.env.OPENCLAW_BOOK_WRITER_CHROME_BIN ?? "",
      params.env.CHROME_BIN ?? "",
      params.env.BROWSER ?? "",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
    ].filter(Boolean),
  );
  if (!chromium) {
    return undefined;
  }
  const profileDir = path.join(
    os.tmpdir(),
    `openclaw-book-writer-print-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const result = await params.commandRunner(
    chromium,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--print-to-pdf-no-header",
      `--print-to-pdf=${params.printPdfPath}`,
      pathToFileURL(params.printHtmlPath).href,
    ],
    { timeoutMs: PDF_EXPORT_TIMEOUT_MS, env: params.env },
  );
  await fs.rm(profileDir, { force: true, recursive: true });
  const valid = await validatePdfHeader(params.printPdfPath);
  return {
    code: "print-pdf-export",
    status: result.code === 0 && valid ? "pass" : "warn",
    message:
      result.code === 0 && valid
        ? "Print PDF exported with Chromium-compatible headless print."
        : `Chromium PDF export failed: ${trimMessage(result.stderr) || "invalid PDF output"}.`,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function textBlocksFromPrintHtml(html: string): string[] {
  return Array.from(html.matchAll(/<(h1|h2|p)[^>]*>(?<text>[\s\S]*?)<\/\1>/gi))
    .map((match) =>
      decodeHtmlEntities((match.groups?.text ?? "").replace(/<br\s*\/?>/gi, "\n"))
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function wrapText(value: string, maxChars: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function escapePdfText(value: string): string {
  return value.replace(/[\\()]/g, (char) => `\\${char}`).replace(/[^\x20-\x7e]/g, "");
}

function buildPdfContentStreams(blocks: string[]): string[] {
  const maxChars = 74;
  const maxLines = Math.floor((PDF_PAGE_HEIGHT - PDF_MARGIN * 2) / PDF_LINE_HEIGHT);
  const pages: string[] = [];
  let lines: string[] = [];
  for (const block of blocks) {
    const wrapped = wrapText(block, maxChars);
    for (const line of wrapped) {
      if (lines.length >= maxLines) {
        pages.push(lines.join("\n"));
        lines = [];
      }
      lines.push(line);
    }
    if (lines.length < maxLines) {
      lines.push("");
    }
  }
  if (lines.length > 0) {
    pages.push(lines.join("\n"));
  }
  return pages.map((pageLines) => {
    const commands = pageLines
      .split("\n")
      .map((line, index) =>
        index === 0
          ? `${PDF_MARGIN} ${PDF_PAGE_HEIGHT - PDF_MARGIN} Td (${escapePdfText(line)}) Tj`
          : `0 -${PDF_LINE_HEIGHT} Td (${escapePdfText(line)}) Tj`,
      )
      .join("\n");
    return `BT
/F1 ${PDF_FONT_SIZE} Tf
${commands}
ET`;
  });
}

function buildBasicPdf(blocks: string[]): Buffer {
  const streams = buildPdfContentStreams(blocks);
  const pageCount = Math.max(1, streams.length);
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectIds = Array.from({ length: pageCount }, (_value, index) => 4 + index * 2);
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  for (let index = 0; index < pageCount; index += 1) {
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = pageObjectId + 1;
    const stream = streams[index] ?? "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>
stream
${stream}
endstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref
0 ${objects.length + 1}
0000000000 65535 f 
${offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
  .join("\n")}
trailer
<< /Size ${objects.length + 1} /Root 1 0 R >>
startxref
${xrefOffset}
%%EOF
`;
  return Buffer.from(body, "utf8");
}

async function exportPdfWithBuiltInWriter(params: {
  printHtmlPath: string;
  printPdfPath: string;
}): Promise<GateFinding> {
  const html = await fs.readFile(params.printHtmlPath, "utf8");
  const blocks = textBlocksFromPrintHtml(html);
  await fs.writeFile(params.printPdfPath, buildBasicPdf(blocks));
  const valid = await validatePdfHeader(params.printPdfPath);
  return {
    code: "print-pdf-export",
    status: valid ? "pass" : "warn",
    message: valid
      ? "Print PDF exported with built-in deterministic 6in x 9in layout."
      : "Built-in PDF writer did not produce a valid PDF.",
  };
}

async function exportPrintPdf(params: {
  printHtmlPath: string;
  printPdfPath: string;
  env: NodeJS.ProcessEnv;
  commandRunner: CommandRunner;
}): Promise<GateFinding> {
  if (params.env.OPENCLAW_BOOK_WRITER_DISABLE_PDF_EXPORT === "1") {
    return {
      code: "print-pdf-export",
      status: "warn",
      message: "Print PDF export is disabled by OPENCLAW_BOOK_WRITER_DISABLE_PDF_EXPORT.",
    };
  }
  if (params.env.OPENCLAW_BOOK_WRITER_EXTERNAL_PDF_EXPORT !== "1") {
    return await exportPdfWithBuiltInWriter(params);
  }
  const cupsResult = await exportPdfWithCupsFilter(params);
  if (cupsResult?.status === "pass") {
    return cupsResult;
  }
  const chromiumResult = await exportPdfWithChromium(params);
  if (chromiumResult?.status === "pass") {
    return chromiumResult;
  }
  const builtInResult = await exportPdfWithBuiltInWriter(params);
  if (builtInResult.status === "pass") {
    return builtInResult;
  }
  if (chromiumResult) {
    return chromiumResult;
  }
  if (cupsResult) {
    return cupsResult;
  }
  return builtInResult;
}

export async function validatePublishingExports(
  options: PublishingExportValidationOptions,
): Promise<PublishingExportValidationResult> {
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const findings: GateFinding[] = [];
  const html = await fs.readFile(options.printHtmlPath, "utf8");
  findings.push(...validatePrintHtml(html));
  findings.push(await validateWithEpubCheck(options.epubPath, env, commandRunner));
  const pdfFinding = await exportPrintPdf({
    printHtmlPath: options.printHtmlPath,
    printPdfPath: options.printPdfPath,
    env,
    commandRunner,
  });
  findings.push(pdfFinding);
  const pdfAvailable = pdfFinding.status === "pass" && (await pathExists(options.printPdfPath));
  return {
    report: {
      status: statusFromFindings(findings),
      findings,
    },
    printPdfPath: pdfAvailable ? options.printPdfPath : undefined,
  };
}
