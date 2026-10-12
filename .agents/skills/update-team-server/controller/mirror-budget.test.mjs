import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Cloning a large mirror can outlast fetching it; foreground auto-gc adds unbounded work.
const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");

test("mirror fetch and candidate clone disable foreground auto-gc", () => {
  assert.match(source, /^mirror_git_config=\(-c gc\.auto=0 -c maintenance\.auto=false\)$/m);
  const fetchLine = source.match(/bounded_build "\$fetch_budget" git "\$\{mirror_git_config\[@\]\}" -C "\$mirror" fetch --prune origin/);
  assert.ok(fetchLine, "mirror fetch carries mirror_git_config");
  const cloneLine = source.match(/bounded_build "\$clone_budget" git "\$\{mirror_git_config\[@\]\}" clone --no-local --no-hardlinks --no-checkout/);
  assert.ok(cloneLine, "candidate clone carries mirror_git_config under clone_budget");
  assert.doesNotMatch(source, /bounded_build "\$fetch_budget" git clone/, "clone no longer shares the fetch budget");
});

test("clone budget is separate from the fetch budget and defaults above it", () => {
  const fetchDefault = Number(source.match(/^fetch_budget="\$\{OPENCLAW_TEAM_FETCH_BUDGET:-(\d+)\}"$/m)[1]);
  const cloneDefault = Number(source.match(/^clone_budget="\$\{OPENCLAW_TEAM_CLONE_BUDGET:-(\d+)\}"$/m)[1]);
  assert.ok(cloneDefault >= 600, `clone budget default ${cloneDefault} < 600 s`);
  assert.ok(cloneDefault > fetchDefault);
  assert.match(source, /bounded_build "\$clone_budget" git "\$\{mirror_git_config\[@\]\}" -C "\$build_directory" checkout --detach "\$target_sha"/);
});
