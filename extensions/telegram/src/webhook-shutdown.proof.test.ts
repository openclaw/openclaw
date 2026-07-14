import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const proofScript = path.join(here, "proof-telegram-webhook-shutdown.mts");

describe("telegram webhook shutdown real-behavior proof", () => {
  it("passes negative, positive, and valid teardown cases", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", proofScript], {
      encoding: "utf8",
      cwd: path.resolve(here, "../../.."),
      env: process.env,
    });
    expect(output).toContain("ALL PROOF ASSERTIONS:");
    expect(output).toMatch(/ALL PROOF ASSERTIONS: \d+ passed, 0 failed/);
    expect(output).toContain("[case 1] negative control");
    expect(output).toContain("[case 2] positive control");
    expect(output).toContain("[case 3] valid path");
  });
});
