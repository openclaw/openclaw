// Build robotjs native module if possible (requires X11 on Linux, Accessibility on macOS).
// Silently skips on platforms where it can't build (e.g. headless CI).
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

try {
  // pnpm stores packages in node_modules/.pnpm/<name>@<version>/node_modules/<name>/
  // Walk up to the workspace root's node_modules/.pnpm directory to find robotjs.
  const pnpmDir = join(process.cwd(), "..", "..", "node_modules", ".pnpm");
  const robotEntry = readdirSync(pnpmDir).find((d) => d.startsWith("robotjs@"));
  if (!robotEntry) throw new Error("robotjs not found in .pnpm store");
  const robotDir = join(pnpmDir, robotEntry, "node_modules", "robotjs");
  execSync("npx node-gyp rebuild", { cwd: robotDir, stdio: "inherit" });
} catch {
  // Expected on headless CI or platforms without display headers.
}
