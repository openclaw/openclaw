import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const publication = source.match(/^atomic_pointer\(\) \{[\s\S]*?^\}/m)[0];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

for (const fault of ["namespace", "link", "rename"]) {
  test(`pointer publication ${fault} failure cannot authorize the next lifecycle step`, t => {
    const root = mkdtempSync(join(tmpdir(), "controller-pointer-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const releases = join(root, "releases"), pointer = join(root, "current");
    const previous = join(releases, "previous"), candidate = join(releases, "candidate");
    mkdirSync(previous, { recursive: true });
    mkdirSync(candidate);
    symlinkSync(previous, pointer);
    const program = `set -euo pipefail
serving_root=${quote(root)}; releases_root=${quote(releases)}
fail() { printf '%s\\n' "$*" >&2; return 1; }
proof() { printf SYNCED; }
ln() { ${fault === "link" ? "return 17" : 'command ln "$@"'}; }
mv() { ${fault === "rename" ? "return 18" : 'command mv "$@"'}; }
${publication}
atomic_pointer ${quote(fault === "namespace" ? join(root, "outside") : candidate)} ${quote(pointer)} || exit 1
printf RESUMED
`;
    const result = spawnSync("bash", ["-c", program], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(readlinkSync(pointer), previous);
    assert.doesNotMatch(result.stdout, /SYNCED|RESUMED/);
  });
}
