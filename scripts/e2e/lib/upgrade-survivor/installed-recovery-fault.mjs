// External observer only: all journal bytes and filesystem mutations belong to
// the installed writer. A process kill is not a claim about power-loss durability.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { readActivation, retirementCuts } from "./installed-recovery-observations.mjs";

const specPath = process.env.OPENCLAW_SURVIVOR_INSTALLED_RECOVERY_FAULT;
if (specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const { cut, root, anchor, helper, journal, evidence } = spec;
  assert(["displaced", ...retirementCuts].includes(cut));
  for (const file of [root, anchor, helper, journal, evidence]) {
    assert(path.isAbsolute(file) && path.resolve(file) === file);
  }
  assert.equal(helper, path.join(`${anchor}.control`, "recovery.mjs"));
  assert.equal(journal, path.join(`${anchor}.control`, "operation.sqlite"));
  const original = { rename: fsp.rename, unlink: fsp.unlink, rmdir: fsp.rmdir, open: fsp.open };
  const checkpoint = (effect, synced = false) => {
    if (fs.existsSync(evidence)) {
      return;
    }
    const row = readActivation(journal);
    const intent = JSON.parse(row.intent_json);
    const descriptor = JSON.parse(row.descriptor_json);
    assert.equal(descriptor.authority.installKey, root);
    if (cut === "displaced") {
      assert.equal(row.phase, "publishing");
      assert.equal(intent.kind, "displace");
      assert.equal(fs.existsSync(root), false);
      assert(fs.existsSync(path.join(anchor, "previous")));
    }
    fs.writeFileSync(evidence, JSON.stringify({ cut, pid: process.pid, effect, synced, row }), {
      flag: "wx",
      mode: 0o600,
    });
    process.kill(process.pid, "SIGKILL");
  };
  fsp.rename = async (source, destination) => {
    const result = await original.rename(source, destination);
    if (cut === "displaced" && source === root && destination === path.join(anchor, "previous")) {
      checkpoint(destination);
    }
    return result;
  };
  fsp.rmdir = async (target, ...args) => {
    if (target === anchor && cut === "anchor-before") {
      checkpoint(target);
    }
    const result = await original.rmdir(target, ...args);
    if (target === anchor && cut === "anchor-after") {
      checkpoint(target);
    }
    return result;
  };
  fsp.unlink = async (target) => {
    if (target === helper && cut === "helper-before") {
      checkpoint(target);
    }
    const result = await original.unlink(target);
    if (target === helper && cut === "helper-after") {
      checkpoint(target);
    } else if (
      cut === "partial-previous" &&
      typeof target === "string" &&
      target.startsWith(`${path.join(anchor, "previous")}${path.sep}`)
    ) {
      checkpoint(target);
    }
    return result;
  };
  fsp.open = async (target, ...args) => {
    const handle = await original.open(target, ...args);
    const directory = cut === "anchor-sync" ? path.dirname(anchor) : path.dirname(helper);
    if ((cut === "anchor-sync" || cut === "helper-sync") && target === directory) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        const result = await sync();
        if (!fs.existsSync(journal)) {
          return result;
        }
        const row = readActivation(journal);
        const intent = JSON.parse(row.intent_json);
        if (
          (cut === "anchor-sync" && intent.kind === "remove-anchor" && !fs.existsSync(anchor)) ||
          (cut === "helper-sync" && intent.kind === "unlink-helper" && !fs.existsSync(helper))
        ) {
          checkpoint(target, true);
        }
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
