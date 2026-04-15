/**
 * Old version (doc v2) Feishu document support.
 *
 * Provides read access to legacy Feishu documents (type `doc`, URL `/docs/:token`)
 * that are not supported by the `@larksuiteoapi/node-sdk` docx API surface.
 *
 * Uses `client.request()` to call old version REST endpoints directly,
 * reusing the SDK's authentication layer (tenant_access_token management).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type {
  OldDocBlock,
  OldDocContent,
  OldDocContentResponse,
  OldDocMetaResponse,
  OldDocRawContentResponse,
} from "./old-doc-types.js";

// ============ Internal client type ============

type OldDocInternalClient = Lark.Client & {
  request(params: {
    method: "GET" | "POST";
    url: string;
    params?: Record<string, string | undefined>;
    data?: unknown;
    timeout?: number;
  }): Promise<unknown>;
};

const OLD_DOC_REQUEST_TIMEOUT_MS = 30_000;

function getOldDocInternalClient(client: Lark.Client): OldDocInternalClient {
  return client as OldDocInternalClient;
}

// ============ API request helpers ============

async function requestOldDocApi<T>(params: {
  client: Lark.Client;
  method: "GET" | "POST";
  url: string;
  query?: Record<string, string | undefined>;
  data?: unknown;
}): Promise<T> {
  const internal = getOldDocInternalClient(params.client);
  return (await internal.request({
    method: params.method,
    url: params.url,
    params: params.query ?? {},
    data: params.data ?? {},
    timeout: OLD_DOC_REQUEST_TIMEOUT_MS,
  })) as T;
}

// ============ API calls ============

/** Fetch document metadata including version info (is_upgraded, upgraded_token). */
export async function fetchOldDocMeta(client: Lark.Client, docToken: string) {
  const res = await requestOldDocApi<OldDocMetaResponse>({
    client,
    method: "GET",
    url: `/open-apis/doc/v2/meta/${encodeURIComponent(docToken)}`,
  });
  if (res.code !== 0) {
    throw new Error(res.msg ?? `Old doc meta API failed (code: ${res.code})`);
  }
  return {
    is_upgraded: res.data?.is_upgraded ?? false,
    upgraded_token: res.data?.upgraded_token,
    title: res.data?.title,
  };
}

/** Fetch document rich content (JSON body structure). */
async function fetchOldDocContent(client: Lark.Client, docToken: string) {
  const res = await requestOldDocApi<OldDocContentResponse>({
    client,
    method: "GET",
    url: `/open-apis/doc/v2/${encodeURIComponent(docToken)}/content`,
  });
  if (res.code !== 0) {
    throw new Error(res.msg ?? `Old doc content API failed (code: ${res.code})`);
  }
  return res;
}

/** Fetch document plain text content. */
async function fetchOldDocRawContent(client: Lark.Client, docToken: string) {
  const res = await requestOldDocApi<OldDocRawContentResponse>({
    client,
    method: "GET",
    url: `/open-apis/doc/v2/${encodeURIComponent(docToken)}/raw_content`,
  });
  if (res.code !== 0) {
    throw new Error(res.msg ?? `Old doc raw content API failed (code: ${res.code})`);
  }
  return res;
}

// ============ Content parsing ============

/** Extract text from an old doc paragraph's elements. */
function extractTextFromParagraph(
  paragraph: { elements?: Array<{ text_run?: { content?: string } }> } | undefined,
): string {
  if (!paragraph?.elements) {
    return "";
  }
  return paragraph.elements.map((el) => el.text_run?.content ?? "").join("");
}

/** Block types that are structured and may not be fully visible in plain text. */
const STRUCTURED_OLD_BLOCK_TYPES = new Set([
  "table",
  "gallery",
  "file",
  "code",
  "sheet",
  "bitable",
  "embeddedPage",
]);

/** Parse old doc blocks into block type counts. */
function countOldBlockTypes(blocks: OldDocBlock[]): {
  blockCounts: Record<string, number>;
  structuredTypes: string[];
} {
  const blockCounts: Record<string, number> = {};
  const structuredTypes: string[] = [];

  for (const block of blocks) {
    const type = block.type || "unknown";
    blockCounts[type] = (blockCounts[type] || 0) + 1;
    if (STRUCTURED_OLD_BLOCK_TYPES.has(type) && !structuredTypes.includes(type)) {
      structuredTypes.push(type);
    }
  }

  return { blockCounts, structuredTypes };
}

// ============ Main read function ============

/** Read an old version Feishu document, returning a unified result shape. */
export async function readOldDoc(client: Lark.Client, docToken: string) {
  const [rawContentRes, contentRes, metaRes] = await Promise.all([
    fetchOldDocRawContent(client, docToken),
    fetchOldDocContent(client, docToken),
    fetchOldDocMeta(client, docToken),
  ]);

  // Parse the rich content JSON string
  let parsedContent: OldDocContent | undefined;
  try {
    const contentStr = contentRes.data?.content;
    if (contentStr) {
      parsedContent = JSON.parse(contentStr) as OldDocContent;
    }
  } catch {
    // If parsing fails, we still have raw content
  }

  const blocks = parsedContent?.body?.blocks ?? [];
  const { blockCounts, structuredTypes } = countOldBlockTypes(blocks);

  // Extract title from content if meta didn't provide one
  const title =
    metaRes.title || (parsedContent ? extractTextFromParagraph(parsedContent.title) : "");

  let hint: string | undefined;
  if (structuredTypes.length > 0) {
    hint = `This is an old-version Feishu document containing ${structuredTypes.join(", ")} which may not be fully visible in plain text. Consider upgrading the document for full block-level access.`;
  }

  return {
    title,
    content: rawContentRes.data?.content ?? "",
    document_version: "old" as const,
    is_upgraded: metaRes.is_upgraded,
    upgraded_token: metaRes.upgraded_token,
    block_count: blocks.length,
    block_types: blockCounts,
    ...(hint && { hint }),
  };
}
