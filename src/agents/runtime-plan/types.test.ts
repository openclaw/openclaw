// Runtime plan type tests keep the leaf type contract free from concrete
// runtime policy modules so the plan can stay a low-dependency boundary.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TYPES_PATH = fileURLToPath(new URL("./types.ts", import.meta.url));

const concreteRuntimePolicyImportPatterns = [
  /from\s+["'][^"']*auto-reply(?:\/|\.js|["'])/,
  /from\s+["'](?:[^"']*\/)?config(?:\/|\.js|["'])/,
  /from\s+["'](?:[^"']*\/)?plugins(?:\/|\.js|["'])/,
  /from\s+["'][^"']*embedded-agent-/,
  /from\s+["'][^"']*transcript-policy(?:\.[^/"']+)?(?:\/|\.js|["'])/,
  /from\s+["'][^"']*system-prompt(?:\.[^/"']+)?(?:\/|\.js|["'])/,
];

describe("AgentRuntimePlan leaf contracts", () => {
  it("keeps runtime plan type contracts independent from concrete runtime policy modules", async () => {
    const source = await fs.readFile(TYPES_PATH, "utf8");

    for (const pattern of concreteRuntimePolicyImportPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });
});
