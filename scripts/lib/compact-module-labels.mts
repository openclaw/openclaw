import { parse } from "@babel/parser";
import { bundledModuleRegions } from "./bundled-module-regions.mjs";

/** Keep module labels as legal comments without shifting source-map positions. */
export function createCompactModuleLabelsPlugin() {
  return {
    name: "openclaw:compact-module-labels",
    renderChunk(code: string, chunk: { fileName: string }) {
      if (/\.d\.[cm]?ts$/u.test(chunk.fileName)) {
        return null;
      }
      const { comments, program } = parse(code, { sourceType: "module", attachComment: false });
      const parts: string[] = [];
      let cursor = 0;
      let statement = 0;
      for (const comment of comments ?? []) {
        if (
          comment.type !== "CommentLine" ||
          !comment.value.startsWith(" ") ||
          bundledModuleRegions(`//${comment.value}`).next().done
        ) {
          continue;
        }
        // Parser offsets are present; comments inside statements cannot establish an owner.
        const start = comment.start!;
        let next = program.body[statement];
        while (next && next.end! <= start) {
          next = program.body[++statement];
        }
        if (next && next.start! < start) {
          continue;
        }
        parts.push(code.slice(cursor, start + 2), "!");
        cursor = start + 3;
      }
      if (!cursor) {
        return null;
      }
      parts.push(code.slice(cursor));
      return { code: parts.join(""), map: null };
    },
  };
}
