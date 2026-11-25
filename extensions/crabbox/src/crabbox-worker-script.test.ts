import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";

const source = 'console.log("Windows 🦞 — 日本語");\n';
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Crabbox guest Node script transport", () => {
  it("preserves the macOS POSIX heredoc", () => {
    expect(wrapCrabboxNodeScript(source, "macos", "GUEST_SCRIPT")).toBe(
      `set -eu\nnode <<'GUEST_SCRIPT'\n${source}\nGUEST_SCRIPT`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "retains the bootstrap Node across fresh shells and replaces an older image binding",
    () => {
      const home = tempDirs.make("crabbox-runtime-node-");
      const bin = path.join(home, "bin");
      const runtimeBin = path.join(home, ".openclaw-worker", "runtime-node");
      fs.mkdirSync(bin);
      fs.mkdirSync(runtimeBin, { recursive: true });
      const staleNode = path.join(home, "stale-node");
      fs.writeFileSync(staleNode, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
      fs.symlinkSync(staleNode, path.join(runtimeBin, "node"));
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      const script = "console.log(process.execPath)";
      const run = (command: string) =>
        execFileSync("/bin/sh", ["-c", command], {
          env: { HOME: home, PATH: bin },
          encoding: "utf8",
        }).trim();
      expect(run(wrapCrabboxNodeScript(script, "linux", "BOOTSTRAP", "bootstrap"))).toBe(
        process.execPath,
      );
      fs.unlinkSync(path.join(bin, "node"));
      expect(run(wrapCrabboxNodeScript(script))).toBe(process.execPath);
      expect(fs.readlinkSync(path.join(runtimeBin, "node"))).toBe(process.execPath);
    },
  );

  it("transports Unicode bytes through a temporary native PowerShell script", () => {
    const command = wrapCrabboxNodeScript(source, "windows/normal");
    const encoded = command.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(source);
    expect(command).toMatchInlineSnapshot(`
      "$ErrorActionPreference = 'Stop'
      $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
      if (-not $node) { throw 'Cloud worker requires Node.js on PATH; update the Crabbox Windows bootstrap image and reprovision the worker' }
      $scriptPath = Join-Path $env:TEMP ('openclaw-' + [Guid]::NewGuid().ToString('N') + '.cjs')
      try {
        $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('Y29uc29sZS5sb2coIldpbmRvd3Mg8J+mniDigJQg5pel5pys6KqeIik7Cg=='))
        [IO.File]::WriteAllText($scriptPath, $source, [Text.UTF8Encoding]::new($false))
        & $node.Source $scriptPath
        $code = $LASTEXITCODE
      } finally {
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
      }
      exit $code"
    `);
  });
});
