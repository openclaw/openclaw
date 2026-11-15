import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyInlineCommandBuilds(cells, comparisonPlan, candidateTree) {
  for (const cell of cells) {
    cell.commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: cell.cwd,
      encoding: "utf8",
    }).trim();
    const html = await readFile(path.join(cell.cwd, "dist/control-ui/index.html"));
    cell.indexSha256 = sha(html);
    cell.runtimeBuild = JSON.parse(
      await readFile(path.join(cell.cwd, "dist/build-info.json"), "utf8"),
    );
    cell.runtimeEntrySha256 = sha(await readFile(path.join(cell.cwd, "dist/index.js")));
    cell.sourceCommit = cell.source;
    assert.equal(cell.commit, cell.sourceCommit, "checkout must match the selected exact source");
    cell.liveOutputExpected = cell.inline;
    cell.tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: cell.cwd,
      encoding: "utf8",
    }).trim();
    assert.equal(cell.tree, comparisonPlan.cells.find((entry) => entry.label === cell.label).tree);
    if (cell.role === "candidate") {
      assert.equal(
        cell.tree,
        candidateTree,
        "candidate transport tree must equal reviewed source tree",
      );
    }
    assert.equal(
      cell.runtimeBuild.commit,
      cell.sourceCommit,
      "Gateway runtime must identify selected original source",
    );
    cell.build = JSON.parse(
      html.toString().match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)[1],
    );
    assert.equal(
      cell.build.commit,
      cell.sourceCommit,
      "UI build must identify selected original source",
    );
    const require = createRequire(path.join(cell.cwd, "extensions/codex/package.json"));
    const codexPackage = require.resolve("@openai/codex/package.json");
    cell.codexVersion = JSON.parse(await readFile(codexPackage, "utf8")).version;
    assert.equal(cell.codexVersion, "0.164.0", "all revisions must use the pinned native binary");
    cell.launcher = path.join(path.dirname(codexPackage), "bin/codex.js");
    cell.launcherSha256 = sha(await readFile(cell.launcher));
    assert.equal(process.arch, "x64", "This workload pins the Linux x64 native package");
    const nativeRequire = createRequire(codexPackage);
    cell.binary = path.join(
      path.dirname(nativeRequire.resolve("@openai/codex-linux-x64/package.json")),
      "vendor/x86_64-unknown-linux-musl/bin/codex",
    );
    cell.binarySha256 = sha(await readFile(cell.binary));
    cell.nativeVersion = execFileSync(cell.launcher, ["--version"], { encoding: "utf8" }).trim();
    assert(cell.nativeVersion.includes(cell.codexVersion));
  }
  for (const cell of cells) {
    assert.equal(cell.launcherSha256, cells[0].launcherSha256);
    assert.equal(cell.binarySha256, cells[0].binarySha256);
  }
}
