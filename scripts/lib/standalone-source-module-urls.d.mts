import type fs from "node:fs";
import type { TsdownPlugin } from "tsdown";

export function createStandaloneSourceModuleUrlPlugin(options: { rootDir: string }): TsdownPlugin;
export function readStandaloneSourceModuleIdentities(options: {
  sourceRoot: string;
  outputRoot: string;
  entries: { output: string; source: string }[];
  fsImpl?: typeof fs;
}): { rendered: Map<string, string[]>; facades: Map<string, string[]> };
export function updateStandaloneSourceModuleUrlChunks(options: {
  outputRoot: string;
  rewrites: { filename: string; original: string | Uint8Array; rewritten: string | Uint8Array }[];
  fsImpl?: typeof fs;
}): number;
