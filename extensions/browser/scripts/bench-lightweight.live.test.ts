import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { launchChromium } from "../src/browser/pw-chromium.test-support.js";
import { isLiveTestEnabled, useAutoCleanupTempDirTracker } from "../test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

it.runIf(isLiveTestEnabled())(
  "records the actual Chromium version in external HTTP and WebSocket benchmark reports",
  async () => {
    const root = tempDirs.make("openclaw-bench-version-");
    const { context, cdpUrl } = await launchChromium(root, { chromiumSandbox: true });
    try {
      const response = await fetch(new URL("/json/version", cdpUrl));
      expect(response.ok).toBe(true);
      const advertised: { Browser: string; webSocketDebuggerUrl: string } = await response.json();
      expect(advertised.Browser).toMatch(/^(HeadlessChrome|Chrome)\/\d+\./);
      expect(advertised.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);

      for (const endpoint of [cdpUrl, advertised.webSocketDebuggerUrl]) {
        const output = path.join(root, new URL(endpoint).protocol.slice(0, -1) + ".json");
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "./scripts/tsx.mjs",
            "extensions/browser/scripts/bench-lightweight.ts",
            "--endpoint",
            endpoint,
            "--engine",
            "chromium",
            "--iterations",
            "1",
            "--output",
            output,
          ],
          { cwd: repoRoot, timeout: 25_000 },
        );
        expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
          results: [{ connectionMode: "external", engineVersion: advertised.Browser }],
        });
      }
    } finally {
      await context.close();
    }
  },
  60_000,
);
