import fs from "node:fs";
import path from "node:path";

process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ??= path.join(process.cwd(), "extensions");

const { buildSecretRefCredentialMatrix } = await import("../src/secrets/credential-matrix.js");

const outputPath = path.join(
  process.cwd(),
  "docs",
  "reference",
  "secretref-user-supplied-credentials-matrix.json",
);

const matrix = buildSecretRefCredentialMatrix();
fs.writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
