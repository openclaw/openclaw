import { parse } from "acorn";
import type { TsdownPlugin } from "tsdown";

/** Read emitted ownership comments, never marker-looking JavaScript literals. */
export function readEmittedModuleRegions(source: string) {
  const regions: Array<{ index: number; owner: string }> = [];
  if (!source.includes("#region ")) {
    return regions;
  }
  parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    onComment(block, text, index) {
      const owner = (block ? /^!#region (.+)$/u : /^!?#region (.+)$/u).exec(text)?.[1];
      if (owner && (text.startsWith("!") || index === 0 || /[\r\n]/u.test(source[index - 1]!))) {
        regions.push({ index, owner });
      }
    },
  });
  return regions;
}

export function createEmittedModuleRegionsPlugin(): TsdownPlugin {
  return {
    name: "openclaw:emitted-module-regions",
    renderChunk(code) {
      let preserved = "";
      let cursor = 0;
      for (const { index } of readEmittedModuleRegions(code)) {
        if (code.startsWith("//#region ", index)) {
          // renderChunk precedes minification and final hashing. Legal comments
          // keep declaration provenance without relying on formatting or maps.
          preserved += `${code.slice(cursor, index + 2)}!`;
          cursor = index + 2;
        }
      }
      return cursor === 0 ? null : { code: preserved + code.slice(cursor), map: null };
    },
  };
}
