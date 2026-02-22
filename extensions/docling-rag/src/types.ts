export interface DoclingRagConfig {
  doclingServeUrl?: string;
  autoManage?: boolean;
  watchDir?: string;
  storePath?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface DocumentRecord {
  id: string;
  name: string;
  path: string;
  format: string;
  pages: number;
  chunks: number;
  ingestedAt: string;
  sizeBytes: number;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  text: string;
  page?: number;
  section?: string;
  embedding?: number[];
}

export interface SearchResult {
  chunk: DocumentChunk;
  document: DocumentRecord;
  score: number;
}

export const DEFAULT_DOCLING_SERVE_URL = "http://127.0.0.1:5001";
export const DEFAULT_STORE_PATH = "~/.openclaw/data/docling-rag";
export const DEFAULT_CHUNK_SIZE = 512;
export const DEFAULT_CHUNK_OVERLAP = 64;

export const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".html",
  ".htm",
  ".csv",
  ".md",
  ".txt",
  ".tex",
  ".png",
  ".jpg",
  ".jpeg",
  ".tiff",
  ".bmp",
  ".webp",
]);
