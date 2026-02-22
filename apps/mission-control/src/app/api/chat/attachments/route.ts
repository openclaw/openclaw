import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";

const MAX_FILE_COUNT = 8;
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 10_000;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "mdx",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "go",
  "rs",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "log",
  "env",
]);

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) {return "";}
  return filename.slice(idx + 1).toLowerCase();
}

function inferCategory(file: File): "image" | "video" | "archive" | "pdf" | "code" | "text" | "unknown" {
  const type = (file.type || "").toLowerCase();
  const ext = getExtension(file.name);

  if (type.startsWith("image/")) {return "image";}
  if (type.startsWith("video/")) {return "video";}
  if (type === "application/pdf" || ext === "pdf") {return "pdf";}

  if (
    type.includes("zip") ||
    type.includes("tar") ||
    type.includes("gzip") ||
    type.includes("7z") ||
    ["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)
  ) {
    return "archive";
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    if (
      ["js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "go", "rs", "rb", "php", "sh", "sql"].includes(ext)
    ) {
      return "code";
    }
    return "text";
  }

  if (type.startsWith("text/")) {return "text";}
  return "unknown";
}

function inferLanguage(filename: string): string | null {
  const ext = getExtension(filename);
  const map: Record<string, string> = {
    js: "JavaScript",
    jsx: "JavaScript (JSX)",
    ts: "TypeScript",
    tsx: "TypeScript (TSX)",
    py: "Python",
    java: "Java",
    c: "C",
    cpp: "C++",
    h: "C Header",
    hpp: "C++ Header",
    go: "Go",
    rs: "Rust",
    rb: "Ruby",
    php: "PHP",
    sh: "Shell",
    sql: "SQL",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    txt: "Text",
    xml: "XML",
    html: "HTML",
    css: "CSS",
  };
  return map[ext] || null;
}

type SerializedAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  category: string;
  language: string | null;
  textPreview: string | null;
};

/**
 * POST /api/chat/attachments
 * Accepts multipart uploads and returns normalized attachment metadata + optional text previews.
 */
export const POST = withApiGuard(async (req: NextRequest) => {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);

    if (files.length === 0) {
      throw new UserError("No files uploaded", 400);
    }
    if (files.length > MAX_FILE_COUNT) {
      throw new UserError(`Too many files (max ${MAX_FILE_COUNT})`, 400);
    }

    const attachments: SerializedAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new UserError(
          `File too large: ${file.name} (max ${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB)`,
          400
        );
      }

      const category = inferCategory(file);
      const language = inferLanguage(file.name);
      let textPreview: string | null = null;

      if (category === "text" || category === "code") {
        const raw = await file.text();
        textPreview = raw.slice(0, MAX_TEXT_PREVIEW_CHARS);
      }

      attachments.push({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        category,
        language,
        textPreview,
      });
    }

    return NextResponse.json({ attachments });
  } catch (error) {
    return handleApiError(error, "Failed to process attachments");
  }
}, ApiGuardPresets.write);
