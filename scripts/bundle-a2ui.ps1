# PowerShell version of bundle-a2ui.sh for Windows
$ErrorActionPreference = "Stop"

function Write-ErrorMessage {
    Write-Error "A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle"
    Write-Error "If this persists, verify pnpm deps and try again."
}

$ROOT_DIR = Split-Path -Parent $PSScriptRoot
$HASH_FILE = Join-Path $ROOT_DIR "src\canvas-host\a2ui\.bundle.hash"
$OUTPUT_FILE = Join-Path $ROOT_DIR "src\canvas-host\a2ui\a2ui.bundle.js"
$A2UI_RENDERER_DIR = Join-Path $ROOT_DIR "vendor\a2ui\renderers\lit"
$A2UI_APP_DIR = Join-Path $ROOT_DIR "apps\shared\OpenClawKit\Tools\CanvasA2UI"

# Docker builds exclude vendor/apps via .dockerignore
if (!(Test-Path $A2UI_RENDERER_DIR) -or !(Test-Path $A2UI_APP_DIR)) {
    if (Test-Path $OUTPUT_FILE) {
        Write-Host "A2UI sources missing; keeping prebuilt bundle."
        exit 0
    }
    Write-ErrorMessage
    Write-Error "A2UI sources missing and no prebuilt bundle found at: $OUTPUT_FILE"
    exit 1
}

$PKG_JSON = Join-Path $ROOT_DIR "package.json"
$PNPM_LOCK = Join-Path $ROOT_DIR "pnpm-lock.yaml"

# Compute hash using Node
$NodeScript = @'
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const rootDir = process.argv[2];
const inputs = process.argv.slice(3);
const files = [];

async function walk(entryPath) {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walk(path.join(entryPath, entry));
    }
    return;
  }
  files.push(entryPath);
}

for (const input of inputs) {
  await walk(input);
}

function normalize(p) {
  return p.split(path.sep).join("/");
}

files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

const hash = createHash("sha256");
for (const filePath of files) {
  const rel = normalize(path.relative(rootDir, filePath));
  hash.update(rel);
  hash.update("\0");
  hash.update(await fs.readFile(filePath));
  hash.update("\0");
}

process.stdout.write(hash.digest("hex"));
'@

try {
    $current_hash = node --input-type=module --eval $NodeScript -- $ROOT_DIR $PKG_JSON $PNPM_LOCK $A2UI_RENDERER_DIR $A2UI_APP_DIR
    
    if (Test-Path $HASH_FILE) {
        $previous_hash = Get-Content $HASH_FILE -Raw
        if ($previous_hash.Trim() -eq $current_hash -and (Test-Path $OUTPUT_FILE)) {
            Write-Host "A2UI bundle up to date; skipping."
            exit 0
        }
    }
    
    Write-Host "Building A2UI bundle..."
    
    # Run TypeScript compilation
    pnpm -s exec tsc -p "$A2UI_RENDERER_DIR\tsconfig.json"
    if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed" }
    
    # Run Rolldown
    pnpm -s exec rolldown -c "$A2UI_APP_DIR\rolldown.config.mjs"
    if ($LASTEXITCODE -ne 0) { throw "Rolldown bundling failed" }
    
    # Write hash file
    $current_hash | Set-Content $HASH_FILE -NoNewline
    
    Write-Host "A2UI bundle complete."
}
catch {
    Write-ErrorMessage
    exit 1
}
