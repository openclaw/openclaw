// Preview/generation and rendering use the same owner as local and CI releases.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  generateMobileReleaseNotes,
  renderMobileReleaseNotes,
} from "./lib/mobile-release-notes.ts";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      ["platform", "plan", "output", "source-sha", "version", "build", "audience", "artifact"].map(
        (name) => [name, { type: "string" as const }],
      ),
    ),
  });
  const platform = values.platform;
  if (platform !== "ios" && platform !== "android") {
    throw new Error("Expected --platform ios or android.");
  }
  const rootDir = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  if (positionals.length === 1 && positionals[0] === "generate" && values.plan && values.output) {
    const artifact = await generateMobileReleaseNotes({
      rootDir,
      platform,
      planPath: path.resolve(values.plan),
      outputPath: path.resolve(values.output),
      sourceSha: values["source-sha"],
    });
    for (const entry of artifact.entries) {
      console.log(`${entry.audience} (${entry.locale}):\n${entry.text}\n`);
    }
    return;
  }
  const audience = values.audience;
  if (
    positionals.length === 1 &&
    positionals[0] === "render" &&
    values.version &&
    values.build &&
    (audience === "ios" || audience === "phone" || audience === "wear")
  ) {
    console.log(
      renderMobileReleaseNotes({
        rootDir,
        platform,
        version: values.version,
        build: values.build,
        audience,
        artifactPath: values.artifact,
      }),
    );
    return;
  }
  throw new Error(
    "Usage: mobile-release-notes.ts generate --platform ios|android --plan <file> --output <file> [--source-sha <historical-sha>]; or render --platform ... --version ... --build ... --audience ios|phone|wear [--artifact <file>].",
  );
}

try {
  await main();
} catch (error) {
  // Provider errors can contain request diagnostics. Never echo credentials or raw responses.
  console.error(
    error instanceof Error
      ? error.message.replace(/sk-[A-Za-z0-9_-]+/gu, "[redacted]")
      : "Release-note generation failed.",
  );
  process.exitCode = 1;
}
