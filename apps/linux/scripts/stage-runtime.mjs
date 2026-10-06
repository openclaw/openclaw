import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const destination = path.join(root, "apps/linux/src-tauri/target/desktop-runtime");

export function resourceBytes(executable) {
  // linuxdeploy rewrites ELF resources even without executable permissions.
  // This fixed envelope is stripped by bundled_runtime.rs; hashes cover raw bytes.
  return Buffer.concat([Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n"), executable]);
}

export function runtimeTarget(triple) {
  if (
    triple.endsWith("-apple-darwin") ||
    triple.includes("-windows-") ||
    triple.endsWith("-unknown-freebsd")
  ) {
    return null; // Bundled Gateway runtimes belong to the Linux companion only.
  }
  const platform = triple.endsWith("-unknown-linux-gnu") ? "linux" : null;
  const arch = triple.startsWith("aarch64-") ? "arm64" : triple.startsWith("x86_64-") ? "x64" : null;
  if (!platform || !arch) {
    throw new Error(`Unsupported embedded runtime target: ${triple}`);
  }
  return { platform, arch };
}

export function stageRuntime(triple) {
  const target = runtimeTarget(triple);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const work = fs.mkdtempSync(`${destination}-`);
  try {
    if (target) {
      const pin = JSON.parse(fs.readFileSync(path.join(root, "scripts/lib/openclaw-bun.json"), "utf8"));
      execFileSync(path.join(root, "scripts/stage-openclaw-bun.sh"), [work, target.platform, target.arch], {
        cwd: root,
        stdio: "inherit",
      });
      const executablePath = path.join(work, "bin/bun");
      const executable = fs.readFileSync(executablePath);
      fs.writeFileSync(executablePath, resourceBytes(executable));
      fs.chmodSync(executablePath, 0o644);
      const files = { "bin/bun": createHash("sha256").update(executable).digest("hex") };
      fs.writeFileSync(path.join(work, "manifest.json"), `${JSON.stringify({
        tag: pin.tag, commit: pin.commit, revision: pin.revision, ...target, files,
      }, null, 2)}\n`);
      fs.rmSync(path.join(work, "bun-manifest.json"));
    } else {
      fs.writeFileSync(path.join(work, "manifest.json"), "{}\n");
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(work, destination);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "linux" ? "unknown-linux-gnu" : process.platform === "win32" ? "pc-windows-msvc" : `unknown-${process.platform}`}`;
  stageRuntime(process.env.TAURI_ENV_TARGET_TRIPLE || host);
}
