import { cp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const packageRoot = join(root, "release");
const appRoot = join(packageRoot, "SNES Studio.app");
const contentsRoot = join(appRoot, "Contents");
const macosRoot = join(contentsRoot, "MacOS");
const resourcesRoot = join(contentsRoot, "Resources");
const embeddedAppRoot = join(resourcesRoot, "app");

if (!existsSync(join(dist, "index.html"))) {
  throw new Error("Build the standalone app before packaging: pnpm --dir apps/snes-studio build");
}

await rm(appRoot, { force: true, recursive: true });
await mkdir(macosRoot, { recursive: true });
await mkdir(resourcesRoot, { recursive: true });
await cp(dist, embeddedAppRoot, { recursive: true });

await writeFile(
  join(contentsRoot, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>snes-studio</string>
  <key>CFBundleIdentifier</key>
  <string>ai.openclaw.snes-studio</string>
  <key>CFBundleName</key>
  <string>SNES Studio</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`,
);

const launcher = join(macosRoot, "snes-studio");
await writeFile(
  launcher,
  `#!/bin/sh
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
open "$APP_DIR/Resources/app/index.html"
`,
);
await chmod(launcher, 0o755);

await writeFile(
  join(packageRoot, "README.txt"),
  `SNES Studio Mac package

Open "SNES Studio.app" to launch the standalone local-first SNES game builder.
The app opens the embedded static dashboard in the default browser and does not
require an OpenClaw Gateway token.

For FXPAK PRO export, keep the 128 GB microSD formatted as FAT32 and preserve
existing .srm files unless explicitly resetting a test card.
`,
);

await writeFile(
  join(packageRoot, "signing-report.json"),
  `${JSON.stringify(
    {
      appBundle: "SNES Studio.app",
      notarizationRequired: true,
      signingIdentity: process.env.SNES_STUDIO_SIGNING_IDENTITY || null,
      status: process.env.SNES_STUDIO_SIGNING_IDENTITY ? "signing-identity-provided" : "unsigned-blocked",
      blockers: process.env.SNES_STUDIO_SIGNING_IDENTITY
        ? []
        : [
            "Developer ID signing identity was not provided.",
            "Apple notarization proof is required before distributing to other MacBooks.",
          ],
    },
    null,
    2,
  )}\n`,
);

console.log(`Packaged ${appRoot}`);
