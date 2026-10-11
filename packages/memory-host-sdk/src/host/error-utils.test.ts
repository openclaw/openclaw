// Memory Host SDK tests cover error formatting and secret redaction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../../../../src/test-utils/env.js";
import { formatErrorMessage } from "./error-utils.js";

let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-redact-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("formatErrorMessage", () => {
  it("redacts repeated key text and replacement metacharacters in values", () => {
    const repeatedSecret = "prefix-LONG_LONG_LONG_TOKEN-suffix";
    const repeatedOutput = formatErrorMessage(`LONG_LONG_LONG_TOKEN=${repeatedSecret}`);
    expect(repeatedOutput).toBe("LONG_LONG_LONG_TOKEN=prefix…ffix");
    expect(repeatedOutput).not.toContain(repeatedSecret);

    const replacementSecret = "$&abcdxxxxxxxxwxyz";
    const replacementOutput = formatErrorMessage(`TOKEN=${replacementSecret}`);
    expect(replacementOutput).toBe("TOKEN=***&abcd…wxyz");
    expect(replacementOutput).not.toContain(replacementSecret);
  });

  it("merges operator redact patterns with provider-token coverage", () => {
    const configPath = writeConfig(`{
      logging: {
        redactPatterns: ["/internal-ticket-([A-Za-z0-9]+)/g"],
      },
    }`);
    const providerToken = `ghp_${"a".repeat(20)}`;
    const customSecret = "internal-ticket-12345";

    const output = withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () =>
      formatErrorMessage(`memory failed: ${providerToken} ${customSecret}`),
    );

    expect(output).not.toContain(providerToken);
    expect(output).not.toContain(customSecret);
    expect(output).toContain("memory failed");
  });
});
