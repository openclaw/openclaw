// scripts/format-docs-check.cjs
// Cross-platform docs formatting check for Windows (CommonJS)
const { execSync } = require("child_process");
const fs = require("fs");

function getFiles(patterns) {
  const gitLs = `git ls-files ${patterns.map((p) => `'${p}'`).join(" ")}`;
  try {
    const files = execSync(gitLs, { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && fs.existsSync(f));
    return files;
  } catch (e) {
    console.error("Failed to list files:", e.message);
    process.exit(1);
  }
}

function runOxfmt(files) {
  let failed = false;
  for (const file of files) {
    try {
      execSync(`oxfmt --check "${file}"`, { stdio: "inherit" });
    } catch {
      failed = true;
    }
  }
  if (failed) {
    process.exit(1);
  }
}

const patterns = ["docs/**/*.md", "docs/**/*.mdx", "README.md"];
const files = getFiles(patterns);
if (files.length === 0) {
  console.log("No docs files found.");
  process.exit(0);
}
runOxfmt(files);
