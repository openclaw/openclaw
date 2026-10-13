import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { readClampedInt } from "../shared/params.js";
import {
  DIR_LIST_DEFAULT_MAX_ENTRIES,
  DIR_LIST_HARD_MAX_ENTRIES,
  DIR_LIST_TOOL_DESCRIPTOR,
} from "./descriptors.js";
import { renderDirectoryText } from "./directory-text.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

function directoryListingText(
  canonicalPath: string,
  entries: Array<Record<string, unknown>>,
  pageToken: string | undefined,
  nextPageToken: string | undefined,
  truncated: boolean,
): string {
  const offset = parseStrictNonNegativeInteger(pageToken) ?? 0;
  const header = JSON.stringify({ path: canonicalPath, returnedCount: entries.length }).slice(
    0,
    -1,
  );
  return renderDirectoryText({
    entries,
    project: ({ name, isDir, size }) => ({ name, isDir, size }),
    render: (visible) => {
      const limited = visible.length < entries.length;
      const continuation = limited
        ? visible.length > 0
          ? String(offset + visible.length)
          : undefined
        : nextPageToken;
      const tail = JSON.stringify({ truncated: limited || truncated, nextPageToken: continuation });
      const listing = `${header},"displayedCount":${visible.length},"entries":[${visible.join(",")}],${tail.slice(1)}`;
      // Keep normal continuation guidance the same size on the last page.
      const note =
        limited && visible.length === 0
          ? "No entries displayed: the next complete entry or directory metadata exceeds the text budget or contains reserved markers. Pagination cannot advance; use available node-local directory capabilities."
          : (limited || truncated) && !continuation
            ? "More entries available; the node supplied no continuation token."
            : "If present, pass nextPageToken as pageToken; keep node and path.";
      return { manifest: listing, text: `${listing}\n${note}` };
    },
    fallback:
      "Directory listing omitted: the resolved path or continuation metadata cannot be represented safely within the 8192-byte text limit. No usable paths or continuation token are shown; use available node-local directory capabilities.",
  });
}

export function createDirListTool(): AnyAgentTool {
  return {
    ...DIR_LIST_TOOL_DESCRIPTOR,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const { node, requestedPath: dirPath } = readRequiredNodePath(params);

      const maxEntries = readClampedInt({
        input: params,
        key: "maxEntries",
        defaultValue: DIR_LIST_DEFAULT_MAX_ENTRIES,
        hardMax: DIR_LIST_HARD_MAX_ENTRIES,
      });

      const pageToken =
        typeof params.pageToken === "string" && params.pageToken.trim()
          ? params.pageToken.trim()
          : undefined;

      const { audit, payload } = await invokeNodeToolPayload({
        node,
        params,
        command: "dir.list",
        commandParams: {
          path: dirPath,
          pageToken,
          maxEntries,
        },
        requestedPath: dirPath,
      });

      const canonicalPath = typeof payload.path === "string" ? payload.path : dirPath;

      const entries = Array.isArray(payload.entries)
        ? (payload.entries as Array<Record<string, unknown>>)
        : [];
      const truncated = payload.truncated === true;
      const nextPageToken =
        typeof payload.nextPageToken === "string" ? payload.nextPageToken : undefined;

      await audit({
        canonicalPath,
        decision: "allowed",
      });

      return textResult(
        directoryListingText(canonicalPath, entries, pageToken, nextPageToken, truncated),
        {
          path: canonicalPath,
          entries,
          nextPageToken,
          truncated,
        },
      );
    },
  };
}
