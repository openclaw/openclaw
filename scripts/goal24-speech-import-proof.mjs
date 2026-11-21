// Compiler-only diagnostic: never runs the app or requests TCC permission.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const nl = String.fromCharCode(10);
const output = path.resolve("compiler-output");
fs.mkdirSync(output);
const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "speech-import-"));
const env = Object.fromEntries(
  ["PATH", "DEVELOPER_DIR", "SDKROOT"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, { HOME: temp, TMPDIR: temp, LANG: "en_US.UTF-8" });
function command(executable, args, cwd = process.cwd()) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
const summary = {
  evidenceKind: "compiler probe only; not app execution or causal proof",
  toolingSha: process.env.GITHUB_SHA,
  variants: [],
};
try {
  summary.swift = command("xcrun", ["swiftc", "--version"]).stdout;
  summary.sdk = command("xcrun", ["--show-sdk-path"]).stdout.trim();
  for (const [variant, sha] of [
    ["original", "2f4ae4d3284bf17ad4930cf6770dac14c025bfc1"],
    ["seam", "77ee3e8424d789b7bad5804a9dc5a1693f34c91e"],
  ]) {
    const directory = path.resolve(variant === "original" ? "baseline" : "source");
    assert.equal(command("git", ["rev-parse", "HEAD"], directory).stdout.trim(), sha);
    const owner = fs.readFileSync(
      path.join(directory, "apps/macos/Sources/OpenClaw/PermissionManager.swift"),
      "utf8",
    );
    let body;
    if (variant === "original") {
      const expression = [
        "await withUnsafeContinuation { (cont: UnsafeContinuation<Void, Never>) in",
        "                SFSpeechRecognizer.requestAuthorization { _ in",
        "                    DispatchQueue.main.async { cont.resume() }",
        "                }",
        "            }",
      ].join(nl);
      assert.equal(owner.split(expression).length, 2);
      body = ["    @MainActor static func originalRequest() async {", expression, "    }"].join(nl);
    } else {
      const start = owner.indexOf(
        ["    @MainActor", "    static func requestSpeechRecognitionAuthorization("].join(nl),
      );
      const end = owner.indexOf(
        ["    @MainActor", "    private static func ensureLocation("].join(nl),
        start,
      );
      assert.ok(start >= 0 && end > start);
      body = owner.slice(start, end);
      const fixed = "request { @Sendable _ in continuation.resume() }";
      assert.equal(body.split(fixed).length, 2);
      body = body.replace(
        fixed,
        [
          "request { _ in",
          "                DispatchQueue.main.async { continuation.resume() }",
          "            }",
        ].join(nl),
      );
    }
    const file = path.join(output, variant + ".swift");
    fs.writeFileSync(
      file,
      ["import Foundation", "import Speech", "enum PermissionManager {", body, "}", ""].join(nl),
    );
    const flags = [
      "-swift-version",
      "6",
      "-enable-upcoming-feature",
      "StrictConcurrency",
      "-Onone",
      "-gline-tables-only",
      "-parse-as-library",
    ];
    for (const [format, option] of [
      ["ast", "-dump-ast"],
      ["sil", "-emit-sil"],
    ]) {
      const args = [...flags, option, file];
      const result = command("xcrun", ["swiftc", ...args]);
      fs.writeFileSync(path.join(output, variant + "." + format), result.stdout);
      fs.writeFileSync(path.join(output, variant + "." + format + ".log"), result.stderr);
      summary.variants.push({ variant, sourceSha: sha, format, args, exitCode: result.status });
      assert.equal(result.status, 0, variant + " compiler probe failed");
      assert.ok(result.stdout.length > 0);
    }
  }
  summary.outcome = "compiler-output-collected";
} catch (error) {
  summary.outcome = "probe-failure";
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + nl);
  fs.rmSync(temp, { recursive: true, force: true });
}
