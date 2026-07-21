// Matrix text preparation keeps transport limits and markdown chunking aligned.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";

const MATRIX_TEXT_LIMIT = 4000;
const getCore = () => getMatrixRuntime();

type MatrixPreparedSingleText = {
  trimmedText: string;
  convertedText: string;
  singleEventLimit: number;
  fitsInSingleEvent: boolean;
};

type MatrixPreparedChunkedText = MatrixPreparedSingleText & {
  chunks: string[];
};

export function prepareMatrixSingleText(
  text: string,
  opts: {
    cfg: CoreConfig;
    accountId?: string;
    tableMode?: MarkdownTableMode;
  },
): MatrixPreparedSingleText {
  const trimmedText = text.trim();
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix text preparation") as CoreConfig;
  const tableMode =
    opts.tableMode ??
    getCore().channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: opts.accountId,
    });
  const convertedText = getCore().channel.text.convertMarkdownTables(trimmedText, tableMode);
  const singleEventLimit = Math.min(
    getCore().channel.text.resolveTextChunkLimit(cfg, "matrix", opts.accountId),
    MATRIX_TEXT_LIMIT,
  );
  return {
    trimmedText,
    convertedText,
    singleEventLimit,
    fitsInSingleEvent: convertedText.length <= singleEventLimit,
  };
}

export function chunkMatrixText(
  text: string,
  opts: {
    cfg: CoreConfig;
    accountId?: string;
    tableMode?: MarkdownTableMode;
  },
): MatrixPreparedChunkedText {
  const preparedText = prepareMatrixSingleText(text, opts);
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix text chunking") as CoreConfig;
  const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
  return {
    ...preparedText,
    chunks: getCore().channel.text.chunkMarkdownTextWithMode(
      preparedText.convertedText,
      preparedText.singleEventLimit,
      chunkMode,
    ),
  };
}
