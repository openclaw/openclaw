/**
 * AssureBot - Document Analysis
 *
 * Extract text from various document formats for AI analysis.
 */

export type DocumentResult = {
  text: string;
  pageCount?: number;
  format: string;
  truncated: boolean;
};

const MAX_TEXT_LENGTH = 50000; // ~12k tokens

/**
 * Extract text from a buffer based on mime type
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename?: string
): Promise<DocumentResult> {
  const ext = filename?.split(".").pop()?.toLowerCase();

  // Plain text files
  if (
    mimeType.startsWith("text/") ||
    ext === "txt" ||
    ext === "md" ||
    ext === "json" ||
    ext === "xml" ||
    ext === "csv" ||
    ext === "log"
  ) {
    return extractPlainText(buffer);
  }

  // PDF
  if (mimeType === "application/pdf" || ext === "pdf") {
    return extractPdf(buffer);
  }

  // Code files (treat as text)
  const codeExtensions = [
    "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java",
    "c", "cpp", "h", "hpp", "cs", "php", "swift", "kt", "scala",
    "sh", "bash", "zsh", "yaml", "yml", "toml", "ini", "env",
    "sql", "graphql", "html", "css", "scss", "less"
  ];
  if (ext && codeExtensions.includes(ext)) {
    return extractPlainText(buffer, ext);
  }

  // Unsupported format
  return {
    text: `[Unsupported document format: ${mimeType}${ext ? ` (.${ext})` : ""}]`,
    format: "unsupported",
    truncated: false,
  };
}

/**
 * Extract plain text
 */
function extractPlainText(buffer: Buffer, format = "text"): DocumentResult {
  let text = buffer.toString("utf-8");
  let truncated = false;

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH) + "\n\n[... truncated ...]";
    truncated = true;
  }

  return { text, format, truncated };
}

/**
 * Extract text from PDF using pdf-parse
 */
async function extractPdf(buffer: Buffer): Promise<DocumentResult> {
  try {
    // Dynamic import to avoid bundling issues
    const pdfParse = await import("pdf-parse").then(m => m.default);
    const data = await pdfParse(buffer);

    let text = data.text;
    let truncated = false;

    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + "\n\n[... truncated ...]";
      truncated = true;
    }

    return {
      text,
      pageCount: data.numpages,
      format: "pdf",
      truncated,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: `[Failed to parse PDF: ${msg}]`,
      format: "pdf-error",
      truncated: false,
    };
  }
}

/**
 * Summarize document metadata for logging
 */
export function summarizeDocument(result: DocumentResult): string {
  const parts = [result.format.toUpperCase()];
  if (result.pageCount) parts.push(`${result.pageCount} pages`);
  parts.push(`${result.text.length} chars`);
  if (result.truncated) parts.push("truncated");
  return parts.join(", ");
}
