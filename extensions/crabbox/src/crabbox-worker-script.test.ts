import { describe, expect, it } from "vitest";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";

const source = 'console.log("Windows 🦞 — 日本語");\n';

describe("Crabbox guest Node script transport", () => {
  it.each(["linux", "windows/wsl2", "macos"] as const)(
    "preserves the POSIX heredoc on %s",
    (target) => {
      expect(wrapCrabboxNodeScript(source, target, "GUEST_SCRIPT")).toBe(
        `set -eu\nnode <<'GUEST_SCRIPT'\n${source}\nGUEST_SCRIPT`,
      );
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
