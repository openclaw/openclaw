import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  claimProofOutput,
  parseProofArgs,
  probeProofCapabilities,
  proofOwnershipSkipReason,
  PROOF_OUTPUT_CLAIM,
  unsupportedProofReason,
} from "./proof-output.mts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), ".proof-output-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const posix = {
  skip: typeof process.getuid !== "function" ? "UID ownership verification unavailable" : false,
};

await test("requires --out and rejects malformed, duplicate and unknown arguments", () => {
  for (const args of [
    [],
    ["--out"],
    ["--out", ""],
    ["--out", "a\0b"],
    ["--out", "--case"],
    ["--out", "a", "--out", "b"],
    ["--unknown"],
    ["legacy-case"],
    ["--out", "a", "--case", "known"],
  ]) {
    assert.throws(() => parseProofArgs(args));
  }
  assert.deepEqual(parseProofArgs(["--out", "a"]), { out: "a", selectedCase: undefined });
});

await test("case selector accepts known names in either order and rejects typos/duplicates", () => {
  assert.deepEqual(parseProofArgs(["--case", "known", "--out", "a"], ["known"]), {
    out: "a",
    selectedCase: "known",
  });
  assert.deepEqual(parseProofArgs(["--out", "a", "--case", "known"], ["known"]), {
    out: "a",
    selectedCase: "known",
  });
  assert.throws(() => parseProofArgs(["--out", "a", "--case", "typo"], ["known"]), /Unknown case/u);
  assert.throws(
    () => parseProofArgs(["--out", "a", "--case", "known", "--case", "known"], ["known"]),
    /Duplicate/u,
  );
});

await test("creates fresh output with permanent exclusive claim", posix, (t) => {
  const out = path.join(fixture(t), "fresh");
  assert.equal(claimProofOutput(out, "test"), out);
  const marker = fs.readFileSync(path.join(out, PROOF_OUTPUT_CLAIM), "utf8");
  assert.equal(JSON.parse(marker).proof, "test");
  assert.throws(() => claimProofOutput(out, "retry"), /empty|claimed/u);
  assert.equal(fs.readFileSync(path.join(out, PROOF_OUTPUT_CLAIM), "utf8"), marker);
});

await test("allows initially empty owned output but failed run cannot reuse it", posix, (t) => {
  const out = path.join(fixture(t), "empty");
  fs.mkdirSync(out);
  claimProofOutput(out, "failed-before-fixtures");
  assert.deepEqual(fs.readdirSync(out), [PROOF_OUTPUT_CLAIM]);
  assert.throws(() => claimProofOutput(out, "retry"), /empty|claimed/u);
});

await test("rejects nonempty output without altering evidence", posix, (t) => {
  const out = fixture(t);
  fs.writeFileSync(path.join(out, "evidence"), "keep");
  assert.throws(() => claimProofOutput(out, "test"), /empty/u);
  assert.deepEqual(fs.readdirSync(out), ["evidence"]);
  assert.equal(fs.readFileSync(path.join(out, "evidence"), "utf8"), "keep");
});

await test("rejects files and missing parents without recursive creation", posix, (t) => {
  const root = fixture(t);
  const file = path.join(root, "file");
  fs.writeFileSync(file, "keep");
  assert.throws(() => claimProofOutput(file, "test"), /directory/u);
  assert.throws(() => claimProofOutput(path.join(root, "missing", "child"), "test"), /ENOENT/u);
  assert.deepEqual(fs.readdirSync(root), ["file"]);
});

await test("rejects output and ancestor symlinks without touching targets", posix, (t) => {
  const root = fixture(t);
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  const link = path.join(root, "link");
  try {
    fs.symlinkSync(target, link, "dir");
  } catch (error) {
    if (["EPERM", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return t.skip("symlinks unavailable");
    }
    throw error;
  }
  assert.throws(() => claimProofOutput(link, "test"), /non-symlink/u);
  assert.throws(() => claimProofOutput(path.join(link, "child"), "test"), /physical directory/u);
  assert.deepEqual(fs.readdirSync(target), []);
});

await test("rejects unowned parents before output creation", posix, (t) => {
  const root = fixture(t);
  const uid = process.getuid!();
  t.mock.method(process, "getuid", () => uid + 1);
  assert.throws(() => claimProofOutput(path.join(root, "out"), "test"), /parent must be owned/u);
  assert.deepEqual(fs.readdirSync(root), []);
});

await test("rejects unowned existing output before marker creation", posix, (t) => {
  const out = path.join(fixture(t), "out");
  fs.mkdirSync(out);
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file: fs.PathLike, options?: unknown) => {
    const stat = lstat(file, options as never);
    if (String(file) === out) {
      Object.defineProperty(stat, "uid", { value: process.getuid!() + 1 });
    }
    return stat;
  });
  assert.throws(() => claimProofOutput(out, "test"), /Output must be owned/u);
  assert.deepEqual(fs.readdirSync(out), []);
});

await test("probes write a report and clean only their owned scratch", posix, (t) => {
  const out = claimProofOutput(path.join(fixture(t), "out"), "test");
  const capabilities = probeProofCapabilities(out);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(out, "capabilities.json"), "utf8")),
    capabilities,
  );
  assert.deepEqual(
    fs.readdirSync(out).toSorted(),
    [PROOF_OUTPUT_CLAIM, "capabilities.json"].toSorted(),
  );
  assert.equal(
    unsupportedProofReason({
      symlinks: true,
      permissions: true,
      hardlinks: false,
      reasons: { hardlinks: "unsupported" },
    }),
    "",
  );
  assert.match(
    unsupportedProofReason(
      {
        symlinks: true,
        permissions: true,
        hardlinks: false,
        reasons: { hardlinks: "unsupported" },
      },
      true,
    ),
    /hardlinks: unsupported/u,
  );
});

await test("unsupported primitives are reported as skips, not silent success", posix, (t) => {
  const out = claimProofOutput(path.join(fixture(t), "out"), "test");
  t.mock.method(fs, "symlinkSync", () => {
    throw Object.assign(new Error("unsupported"), { code: "EPERM" });
  });
  t.mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
  });
  const capabilities = probeProofCapabilities(out);
  assert.equal(capabilities.symlinks, false);
  assert.equal(capabilities.hardlinks, false);
  assert.match(unsupportedProofReason(capabilities), /symlinks/u);
});

await test("reports unavailable ownership and refuses before mutation", (t) => {
  const root = fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  t.after(() => {
    if (descriptor) {
      Object.defineProperty(process, "getuid", descriptor);
    } else {
      Reflect.deleteProperty(process, "getuid");
    }
  });
  Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
  assert.match(proofOwnershipSkipReason() ?? "", /ownership verification unavailable/u);
  assert.throws(
    () => claimProofOutput(path.join(root, "out"), "test"),
    /ownership cannot be verified/u,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});
