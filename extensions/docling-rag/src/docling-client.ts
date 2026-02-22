/**
 * HTTP client for docling-serve REST API.
 *
 * Handles document conversion and chunking via the docling-serve /v1/ endpoints.
 * See: https://github.com/docling-project/docling-serve
 */

import fs from "node:fs";
import path from "node:path";

export interface ConvertResult {
  markdown: string;
  pages: number;
  format: string;
}

export interface ChunkResult {
  chunks: Array<{
    text: string;
    page?: number;
    section?: string;
  }>;
  pages: number;
  format: string;
}

export class DoclingClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DoclingClientError";
  }
}

export class DoclingClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async convertFile(filePath: string): Promise<ConvertResult> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new DoclingClientError(`File not found: ${resolvedPath}`);
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const blob = new Blob([fileBuffer]);

    const formData = new FormData();
    formData.append("files", blob, fileName);
    formData.append("to_formats", "md");

    const resp = await fetch(`${this.baseUrl}/v1/convert/file`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new DoclingClientError(
        `Docling conversion failed (${resp.status}): ${body}`,
        resp.status,
      );
    }

    const data = (await resp.json()) as {
      document?: { md_content?: string; num_pages?: number; input_format?: string };
      documents?: Array<{ md_content?: string; num_pages?: number; input_format?: string }>;
    };

    const doc = data.document ?? data.documents?.[0];
    if (!doc) {
      throw new DoclingClientError("Docling returned no document in response");
    }

    return {
      markdown: doc.md_content ?? "",
      pages: doc.num_pages ?? 0,
      format: doc.input_format ?? path.extname(resolvedPath).slice(1),
    };
  }

  async chunkFile(
    filePath: string,
    opts?: { chunkSize?: number; chunkOverlap?: number },
  ): Promise<ChunkResult> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new DoclingClientError(`File not found: ${resolvedPath}`);
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const blob = new Blob([fileBuffer]);

    const formData = new FormData();
    formData.append("files", blob, fileName);
    formData.append("convert_to_formats", "md");

    const resp = await fetch(`${this.baseUrl}/v1/chunk/hybrid/file`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new DoclingClientError(
        `Docling chunking failed (${resp.status}): ${body}`,
        resp.status,
      );
    }

    const data = (await resp.json()) as {
      chunks?: Array<{ text?: string; meta?: { page?: number; headings?: string[] } }>;
      documents?: Array<{ num_pages?: number; input_format?: string }>;
    };

    const chunks = (data.chunks ?? []).map((c) => ({
      text: c.text ?? "",
      page: c.meta?.page,
      section: c.meta?.headings?.join(" > "),
    }));

    const doc = data.documents?.[0];

    return {
      chunks,
      pages: doc?.num_pages ?? 0,
      format: doc?.input_format ?? path.extname(resolvedPath).slice(1),
    };
  }
}
