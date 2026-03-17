#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const outPath = resolve(process.cwd(), "ui/src/ui/mission-control/generated-config.ts");
const content =
  `import missionControlConfig from "../../../../mission-control.config.json" with { type: "json" };\n\n` +
  `type MissionControlConfig = {\n` +
  `  featureFlags?: { missionControl?: boolean };\n` +
  `  workflow?: { stages?: string[]; guardrails?: string[] };\n` +
  `  team?: {\n` +
  `    agents?: Array<{ id: string; displayName: string; role: string; allowedModes: string[]; defaultMode?: string }>;\n` +
  `  };\n` +
  `  scoringWeights?: Record<string, number>;\n` +
  `};\n\n` +
  `export const MC_CONFIG = missionControlConfig as MissionControlConfig;\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content, "utf8");
console.log(`Wrote ${outPath}`);
