/**
 * Type definitions for Feishu old version (doc v2) document structures.
 *
 * Old version documents use URL format `/docs/:docs_token` and type field `doc`.
 * They are distinct from upgraded documents (`/docx/:docx_token`, type `docx`).
 *
 * Reference: https://open.feishu.cn/document/server-docs/docs/docs/docs-doc-overview
 */

// ============ Element types ============

export type OldDocTextRun = {
  content?: string;
  link?: string;
  text_element_style?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    inline_code?: boolean;
    link?: { url?: string };
  };
};

export type OldDocElement = {
  type?: string;
  text_run?: OldDocTextRun;
  mention?: { tenant_key?: string; user_id?: string; open_id?: string };
  equation?: { content?: string };
};

// ============ Block types ============

export type OldDocParagraph = {
  elements?: OldDocElement[];
  style?: {
    align?: string;
    heading_level?: number;
    list?: { type?: string };
  };
};

export type OldDocTableCell = {
  content?: { blocks?: OldDocBlock[] };
  cell_style?: Record<string, unknown>;
};

export type OldDocTableRow = {
  cells?: OldDocTableCell[];
};

export type OldDocTable = {
  row_size?: number;
  column_size?: number;
  rows?: OldDocTableRow[];
  style?: Record<string, unknown>;
};

export type OldDocCode = {
  language?: string;
  elements?: OldDocElement[];
  style?: Record<string, unknown>;
};

export type OldDocGallery = {
  images?: Array<{
    file_token?: string;
    width?: number;
    height?: number;
  }>;
};

export type OldDocFile = {
  file_token?: string;
  name?: string;
  type?: string;
  size?: number;
};

export type OldDocBlock = {
  type: string;
  paragraph?: OldDocParagraph;
  table?: OldDocTable;
  code?: OldDocCode;
  gallery?: OldDocGallery;
  file?: OldDocFile;
  callout?: OldDocParagraph;
  horizontalLine?: Record<string, unknown>;
  embeddedPage?: { url?: string };
  sheet?: Record<string, unknown>;
  bitable?: Record<string, unknown>;
};

// ============ Document content ============

export type OldDocContent = {
  title?: OldDocParagraph;
  body?: {
    blocks?: OldDocBlock[];
  };
};

// ============ API response types ============

export type OldDocMetaResponse = {
  code: number;
  msg?: string;
  data?: {
    title?: string;
    create_time?: number;
    edit_time?: number;
    creator?: string;
    owner?: string;
    delete_flag?: number;
    is_upgraded?: boolean;
    upgraded_token?: string;
    obj_type?: string;
    url?: string;
  };
};

export type OldDocContentResponse = {
  code: number;
  msg?: string;
  data?: {
    content?: string; // JSON-encoded OldDocContent
    revision?: number;
  };
};

export type OldDocRawContentResponse = {
  code: number;
  msg?: string;
  data?: {
    content?: string;
  };
};
