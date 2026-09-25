import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PackagedOwnerEvidence = {
  file: string;
  sha256: string;
  exports?: Record<string, string>;
};

export async function verifyPackageMember(packageRoot: string, tarball: string, file: string) {
  const relative = path.relative(packageRoot, file).replaceAll(path.sep, "/");
  assert.ok(relative.startsWith("dist/") && !relative.split("/").includes(".."));
  const bytes = execFileSync("tar", ["-xOf", tarball, `package/${relative}`], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
    sha256,
    `Installed module differs from the bound package: ${relative}`,
  );
  return { file: relative, sha256 };
}

type Callable = (...args: unknown[]) => unknown;
function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

// Use named owner exports, never coincidental minified function names. Missing or
// ambiguous owners fail instead of replacing production authority in the fixture.
export async function loadPackagedOwner(
  packageRoot: string,
  tarball: string,
  stem: string,
  names: readonly string[],
  evidence: PackagedOwnerEvidence[],
) {
  const matches = new Map<string, Array<{ file: string; alias: string }>>();
  for (const name of await fs.readdir(path.join(packageRoot, "dist"))) {
    if (!name.startsWith(`${stem}-`) || !/\.[cm]?js$/u.test(name)) {
      continue;
    }
    const file = path.join(packageRoot, "dist", name);
    const source = await fs.readFile(file, "utf8");
    const aliases = new Map<string, string>();
    for (const clause of source.matchAll(/export\s*\{([^}]+)\}/gu)) {
      assert.ok(clause[1]);
      for (const entry of clause[1].split(",")) {
        const match = /^\s*([$\w]+)(?:\s+as\s+([$\w]+))?\s*$/u.exec(entry);
        if (match?.[1]) {
          aliases.set(match[1], match[2] ?? match[1]);
        }
      }
    }
    for (const [symbol, alias] of aliases) {
      if (!names.includes(symbol)) {
        continue;
      }
      const owners = matches.get(symbol) ?? [];
      owners.push({ file, alias });
      matches.set(symbol, owners);
    }
  }
  const selected = new Map<string, Map<string, string>>();
  for (const name of names) {
    const owners = matches.get(name) ?? [];
    assert.equal(owners.length, 1, `Expected one packaged ${stem} owner for ${name}`);
    const match = owners[0];
    assert.ok(match);
    const aliases = selected.get(match.file) ?? new Map<string, string>();
    aliases.set(name, match.alias);
    selected.set(match.file, aliases);
  }
  // Build output can split one owner's exports across implementation and facade
  // chunks. Authenticate every selected member before importing any of them.
  const bindings = new Map<string, PackagedOwnerEvidence>();
  for (const file of selected.keys()) {
    bindings.set(file, await verifyPackageMember(packageRoot, tarball, file));
  }
  const owner: Record<string, Callable> = {};
  for (const [file, aliases] of selected) {
    const namespace: Record<string, unknown> = await import(pathToFileURL(file).href);
    const exports: Record<string, string> = {};
    for (const [name, alias] of aliases) {
      const value: unknown = namespace[alias];
      assert.ok(isCallable(value), `Missing callable ${name}`);
      owner[name] = value;
      exports[name] = alias;
    }
    const binding = bindings.get(file);
    assert.ok(binding);
    evidence.push({ ...binding, exports });
  }
  return owner;
}
