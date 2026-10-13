import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";

/** Crabbox executes script-stdin with the target's native shell. */
export function wrapCrabboxNodeScript(
  script: string,
  target: CrabboxOperatingSystem = "linux",
  delimiter = "CRABBOX_NODE_SCRIPT",
): string {
  if (target !== "windows/normal") {
    return `set -eu\nnode <<'${delimiter}'\n${script}\n${delimiter}`;
  }
  return `$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) { throw 'Cloud worker requires Node.js on PATH; update the Crabbox Windows bootstrap image and reprovision the worker' }
$scriptPath = Join-Path $env:TEMP ('openclaw-' + [Guid]::NewGuid().ToString('N') + '.cjs')
try {
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString("base64")}'))
  [IO.File]::WriteAllText($scriptPath, $source, [Text.UTF8Encoding]::new($false))
  & $node.Source $scriptPath
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
}
exit $code`;
}
