// This helper intentionally clears NODE_OPTIONS. Its closed native lifetime is
// evidence of teardown, never a substitute for JavaScript or SQLite observation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { types } from "node:util";
import { fileIdentity } from "./installed-recovery-observations.mjs";
import { readInstalledTerminalDependencyTree } from "./installed-terminal-contracts.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const host = "dist/infra/directory-watch-host.worker.js";
const parent = "dist/infra/directory-watch-parent.worker.js";
// Both reviewed closures include the manifest-resolved parent thread. The older
// closure still has an unfinished installed-proof consumer; filenames alone never qualify.
const closures = [
  {
    sha256: "2b9bd475ccf1542ce947df99bd9235baa066a23d01b6b7ec3ac9676c3c377941",
    files: [
      [
        "dist/cli-invocation-BV0wa-I-.mjs",
        9550,
        "931da804d9c218318afde4c79850cbfbaf346156fe2e93d4e456b6af3e51ad4e",
      ],
      [
        "dist/gateway-shutdown-budget-De4qQu26.mjs",
        2022,
        "bb26e24af6bcd068764a68bee69ba74e9cc43479d3e5a3263b523b3abfce2278",
      ],
      [host, 1569, "0f1ec5f29af894608f42e62cd835c98dab5f7545d1001dffe7a1f41d0bbd8916"],
      [parent, 346, "e5bd1b731870764d8b086b2bad5a44c1e5357d22b0f0e425d8b70dedcd2a2b22"],
      [
        "dist/runtime-binary-0X1YU7zH.mjs",
        3722,
        "b385d6e258451a39ac0e64dfc4ec2de2662898447957af740a83feb49bf99559",
      ],
      [
        "dist/runtime-process-bootstrap.generated-CPUPb_cD.mjs",
        904,
        "47e22e5f6379f7801e86df731f2d1a3d04db53465f650ba45adefd743e310d6e",
      ],
      [
        "dist/runtime-process-entrypoints-CBkgt-O1.mjs",
        369,
        "36b8a2e306c336f526477e51e6045c763b5aeefc7619aff34ad77c86a8cfae84",
      ],
      [
        "dist/runtime-process-manifest-BDtYX9i8.mjs",
        24252,
        "52b0b93e55e49aabf1682c6477e99885f9315bf9a31f2e3297c7b5cfc31566ee",
      ],
      [
        "dist/runtime-process-scripts.generated-DZVe0fhG.mjs",
        30946,
        "682c784a302af677b456e3459427f1cb6eb32939fe201b0966a894aa90923e8b",
      ],
      [
        "dist/runtime-process-url-CudnJwfS.mjs",
        3014,
        "f72eec33dc6a2d97ba5dba4fb026bbd820923b5df3c9cf0398be7fde9061d91d",
      ],
      [
        "dist/runtime-worker-url-Cwt-1GdQ.mjs",
        2922,
        "257258cc7d9ffb80724292c9b92c2e7512977d30c073eaf48bf872907e60cc1a",
      ],
    ],
  },
  {
    sha256: "63d4d5e471699b2f1bd940e1b3e05d63b4a192861172449e309bb3b24885ae2e",
    files: [
      [
        "dist/cli-invocation-D91ZOETd.mjs",
        7488,
        "e0c53a7dde5a846cdfbe31990143ce9366f401ba667f92ff291049f1e060afbc",
      ],
      [
        "dist/gateway-shutdown-budget-Utx5eFL-.mjs",
        1632,
        "97b148cc056f0d1d79315134644bcc109fabf18d28e949c606f680cc42a9ed0d",
      ],
      [
        "dist/infra/directory-watch-host.worker.js",
        1304,
        "834defe1e73a1d9e34e2df15db5a608a8864e5c3879bcaecd49c98e35fedcad8",
      ],
      [
        "dist/infra/directory-watch-parent.worker.js",
        318,
        "ab57f5068356374a2c10b88e83654cc00e61f49d4233165ef8c098dc9234b026",
      ],
      [
        "dist/runtime-binary-DNstBs1K.mjs",
        2965,
        "825f5d58e6cbc49de6b91d8249564e42c845251fe83970942495a7c32b8ae56d",
      ],
      [
        "dist/runtime-process-bootstrap.generated-oBqwef45.mjs",
        594,
        "5a8b2b323eacaabb42cba0c7c910292a5b89c977f2f785089e8fb049c2c7c123",
      ],
      [
        "dist/runtime-process-entrypoints-BVKb5-M_.mjs",
        353,
        "480494f43911307d668c6fec4499eed7499ad49fc2ff54befb18691e4e5307b5",
      ],
      [
        "dist/runtime-process-manifest-CYlSRkG1.mjs",
        22512,
        "f43f09fcbc3c0e7114e07bec061f9369a14d78b4a210ad63a2fc4bfd2d5dedeb",
      ],
      [
        "dist/runtime-process-scripts.generated-DVFEOcm2.mjs",
        32741,
        "2144d3e2943dc5cbe712965ee66ddac56a0370c3e566475af1622bed9af9351a",
      ],
      [
        "dist/runtime-process-url-CL3_jEBq.mjs",
        2657,
        "0185cb70a91ff09090209b73121e1a0bfafdffcb7b443cdf82fa3a560b3051c2",
      ],
      [
        "dist/runtime-worker-url-CYdCRlrG.mjs",
        2198,
        "07fff1d985704c65b2748034879d7b9196918890221dbc171cf42556946d2be3",
      ],
    ],
  },
];
// fs-safe/json is eagerly imported by runtime-worker-url, even though this
// .js worker never calls its JSON reader. Bind content, not a version label.
const dependencySha256 = "4b955b777dce5967e0564965b8d673cf96f640aace7dc2ca99f14b00c156feb0";
const dependencyManifestSha256 = "0c154a03725c38851263848b9f133baafd4eec359b0d2d843d7865ef07202b16";
const registrationKey = Symbol.for("openclaw.retainedUpdateRuntimes");
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the actual native Set receiver.
const setForEach = Set.prototype.forEach;
// Node can inject permission flags into NODE_OPTIONS after spawn normalization.
// That mode is outside the reviewed empty-preload launch contract.
const permissionMode = Object.hasOwn(process, "permission");
const identityPattern = /^\d+:\d+$/u;
const inside = (root, file) => file.startsWith(`${root}${path.sep}`);
const runtimeIdentity = [
  "root",
  "rootIdentity",
  "manifestSha256",
  "closureSha256",
  "dependencyRoot",
  "dependencyIdentity",
  "dependencySha256",
];

function physical(file, directory = false) {
  assert(path.isAbsolute(file) && path.normalize(file) === file);
  let ancestor = file;
  while (true) {
    assert(!fs.lstatSync(ancestor).isSymbolicLink(), "Directory watch path contains a symlink");
    if (ancestor === path.dirname(ancestor)) {
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile());
  return stat;
}

function read(file, maxBytes) {
  const before = physical(file);
  assert(before.size <= maxBytes);
  const bytes = fs.readFileSync(file);
  const after = physical(file);
  assert.equal(bytes.length, before.size);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  return bytes;
}

function projection(directory, source) {
  const base = path.parse(source).root;
  return path.join(
    directory,
    "tree",
    Buffer.from(base).toString("hex"),
    path.relative(base, source),
  );
}

function runtime(root) {
  const qualificationStartedAt = String(process.hrtime.bigint());
  physical(root, true);
  const rootIdentity = fileIdentity(root);
  const hostBytes = read(path.join(root, host), 64 * 1024);
  const hostSha256 = digest(hostBytes);
  const closure = closures.find(({ files }) =>
    files.some(([relative, , sha256]) => relative === host && sha256 === hostSha256),
  );
  assert(closure, "Directory watch module changed");
  const { files, sha256: closureSha256 } = closure;
  const actual = files.map(([relative, size, sha256]) => {
    const bytes = relative === host ? hostBytes : read(path.join(root, relative), 64 * 1024);
    assert.equal(bytes.length, size, "Directory watch module size changed");
    assert.equal(digest(bytes), sha256, "Directory watch module changed");
    return [relative, size, sha256];
  });
  assert.equal(digest(JSON.stringify(actual)), closureSha256);
  const manifest = read(path.join(root, "package.json"), 1024 * 1024);
  const metadata = JSON.parse(manifest);
  assert.equal(metadata.name, "openclaw");
  assert.equal(metadata.type, "module");
  for (const relative of ["dist/package.json", "dist/infra/package.json"]) {
    assert.equal(
      fs.lstatSync(path.join(root, relative), { throwIfNoEntry: false }),
      undefined,
      "Directory watch module scope changed",
    );
  }
  const resolved = createRequire(path.join(root, host)).resolve("@openclaw/fs-safe/json");
  const dependencyRoot = fs.realpathSync(path.resolve(path.dirname(resolved), ".."));
  assert.equal(resolved, path.join(dependencyRoot, "dist/json.js"));
  assert(
    inside(path.join(root, "node_modules"), dependencyRoot),
    "Directory watch dependency escaped its package",
  );
  assert.equal(
    digest(read(path.join(dependencyRoot, "package.json"), 64 * 1024)),
    dependencyManifestSha256,
  );
  const dependency = readInstalledTerminalDependencyTree(dependencyRoot);
  assert.equal(dependency.entries, 715);
  assert.equal(dependency.sha256, dependencySha256, "Directory watch dependency content changed");
  assert.equal(fileIdentity(root), rootIdentity);
  return {
    root,
    rootIdentity,
    manifestSha256: digest(manifest),
    closureSha256,
    dependencyRoot,
    dependencyIdentity: dependency.identity,
    dependencySha256,
    qualificationStartedAt,
    qualifiedAt: String(process.hrtime.bigint()),
  };
}

/** Called before the native spawn, using the observer's inert launch snapshot. */
export function captureDirectoryWatchLaunch(command, launch, environment) {
  const { argv, options } = launch;
  if (
    command !== process.execPath ||
    permissionMode ||
    argv?.length !== 2 ||
    !argv[0].endsWith(`/${host}`) ||
    argv[1] !== String(process.pid) ||
    !options ||
    Object.keys(options).some((key) => !["stdio", "detached", "env"].includes(key)) ||
    options.detached !== true ||
    !Array.isArray(options.stdio) ||
    options.stdio.length !== 3 ||
    options.stdio[0] !== "pipe" ||
    options.stdio[1] !== "pipe" ||
    options.stdio[2] !== "ignore" ||
    !options.env ||
    options.env.NODE_OPTIONS !== undefined ||
    environment?.environmentQualified !== true ||
    (!Object.hasOwn(options.env, "NODE_V8_COVERAGE") && process.env.NODE_V8_COVERAGE) ||
    Object.entries(options.env).some(
      ([key, value]) =>
        // Node serializes key=value; an '=' in the key can introduce a loader
        // even when the original NODE_OPTIONS property is explicitly undefined.
        (value !== undefined && key.includes("=")) ||
        (value &&
          /^(?:NODE_OPTIONS$|NODE_PATH$|BUN_OPTIONS$|LD_|DYLD_|OPENSSL_CONF$|OPENSSL_MODULES$|NODE_EXTRA_CA_CERTS$|NODE_V8_COVERAGE$|NODE_REDIRECT_WARNINGS$)/iu.test(
            key,
          )),
    )
  ) {
    return undefined;
  }
  return {
    ...runtime(argv[0].slice(0, -host.length - 1)),
    executableIdentity: fileIdentity(process.execPath),
    environment,
  };
}

/** Registration belongs to this parent, before the retained worker can start. */
export function captureRetainedDirectoryWatchRuntime(launch, qualified, spec) {
  if (
    !qualified ||
    !launch.options ||
    launch.options.shell ||
    !launch.argv?.[0] ||
    !path.isAbsolute(launch.argv[0])
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, registrationKey);
  const active = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (
    !active ||
    types.isProxy(active) ||
    Object.getPrototypeOf(active) !== Set.prototype ||
    Reflect.ownKeys(active).length !== 0
  ) {
    return undefined;
  }
  const directories = [];
  // Use the captured native operation, never a product-supplied iterator/getter.
  Reflect.apply(setForEach, active, [
    (directory) => {
      assert(directories.length < 16, "Retained runtime registration census exceeded");
      directories.push(directory);
    },
  ]);
  for (const directory of directories) {
    if (typeof directory !== "string") {
      continue;
    }
    const root = projection(directory, qualified.root);
    if (!inside(path.join(root, "dist"), launch.argv[0])) {
      continue;
    }
    physical(directory, true);
    const directoryIdentity = fileIdentity(directory);
    physical(root, true);
    const contract = spec.heartbeatWorkers.find(
      (entry) =>
        entry.inventorySha256 === qualified.inventorySha256 &&
        entry.sourceCommit === qualified.sourceCommit,
    );
    assert(contract);
    const inventory = read(contract.inventory.path, 4 * 1024 * 1024);
    assert.equal(digest(inventory), contract.inventory.sha256);
    const relative = path.relative(root, launch.argv[0]);
    const expected = JSON.parse(inventory).files[relative];
    assert(expected && !expected.symlink, "Retained worker is absent from source inventory");
    const entry = read(launch.argv[0], 4 * 1024 * 1024);
    assert.equal(digest(entry), expected.sha256, "Retained worker differs from source inventory");
    const facts = runtime(root);
    assert.equal(facts.manifestSha256, qualified.manifestSha256);
    assert.equal(fileIdentity(directory), directoryIdentity, "Retained registration root changed");
    return {
      ...facts,
      directory,
      directoryIdentity,
      sourceRoot: qualified.root,
      sourceRootIdentity: qualified.rootIdentity,
      sourceCommit: qualified.sourceCommit,
      inventorySha256: qualified.inventorySha256,
      entry: launch.argv[0],
      entrySha256: expected.sha256,
      capturedAt: String(process.hrtime.bigint()),
    };
  }
  return undefined;
}

/** Admission joins producer custody to observed startup; identical copies are not owners. */
export function directoryWatchCoverage(created, rows, spec, isPackageRoot) {
  const facts = created.directoryWatch;
  if (!facts) {
    return undefined;
  }
  const ownerStarts = rows.filter(
    (row) => row.event === "startup" && row.pid === created.pid && row.thread === 0,
  );
  assert.equal(ownerStarts.length, 1, "Directory watch has no unique owning startup");
  assert.equal(created.command, ownerStarts[0].argv[0]);
  assert.equal(facts.executableIdentity, ownerStarts[0].executableIdentity);
  assert(identityPattern.test(facts.executableIdentity));
  assert.deepEqual(created.argv, [path.join(facts.root, host), String(created.pid)]);
  assert(created.nodeChild && created.api === undefined);
  assert(
    identityPattern.test(facts.rootIdentity) && identityPattern.test(facts.dependencyIdentity),
  );
  assert(closures.some(({ sha256 }) => sha256 === facts.closureSha256));
  assert.equal(facts.dependencySha256, dependencySha256);
  assert(
    BigInt(facts.qualificationStartedAt) <= BigInt(facts.qualifiedAt) &&
      BigInt(facts.qualifiedAt) < BigInt(created.time),
  );
  assert.equal(facts.environment?.environmentQualified, true);
  const cache = facts.environment.inheritedCache;
  assert(
    cache === null ||
      (cache?.base === spec.compileCacheBase &&
        cache.ancestorsPhysical === true &&
        cache.stateDisjoint === true &&
        (cache.directory === cache.base || inside(cache.base, cache.directory))),
    "Directory watch compile cache is outside custody",
  );
  assert(inside(path.join(facts.root, "node_modules"), facts.dependencyRoot));
  const qualified = (receipt) =>
    spec.heartbeatWorkers?.some(
      (contract) =>
        contract.inventorySha256 === receipt.inventorySha256 &&
        contract.sourceCommit === receipt.sourceCommit &&
        contract.dependencies?.sha256 === receipt.dependencySha256 &&
        contract.dependencyReferenceSha256 === receipt.dependencyReferenceSha256,
    );
  const source = (root, rootIdentity, manifestSha256, pid, before) =>
    isPackageRoot(root) &&
    rows.some(
      (row) =>
        row.event === "heartbeat-package" &&
        row.pid === pid &&
        row.root === root &&
        row.rootIdentity === rootIdentity &&
        row.manifestSha256 === manifestSha256 &&
        qualified(row) &&
        BigInt(row.time) < BigInt(before),
    );
  const installed = source(
    facts.root,
    facts.rootIdentity,
    facts.manifestSha256,
    created.pid,
    created.time,
  );
  if (!installed) {
    const owners = rows.filter(
      (row) => row.event === "spawn" && row.child === created.pid && row.retainedRuntime,
    );
    assert.equal(owners.length, 1, "Directory watch has no registered retained owner");
    const producer = owners[0];
    const retained = producer.retainedRuntime;
    assert(producer.nodeChild && producer.api === undefined);
    assert.equal(ownerStarts[0].ppid, producer.pid);
    assert.equal(ownerStarts[0].argv[1], retained.entry);
    assert.equal(producer.command, ownerStarts[0].argv[0]);
    assert.equal(producer.argv[0], retained.entry);
    assert(inside(path.join(retained.root, "dist"), retained.entry));
    assert(/^[a-f0-9]{64}$/u.test(retained.entrySha256));
    assert(BigInt(retained.capturedAt) < BigInt(producer.time));
    assert(BigInt(producer.time) < BigInt(ownerStarts[0].time));
    assert(BigInt(ownerStarts[0].time) < BigInt(created.time));
    assert.equal(retained.root, projection(retained.directory, retained.sourceRoot));
    assert(identityPattern.test(retained.directoryIdentity));
    assert.deepEqual(
      Object.fromEntries(runtimeIdentity.map((key) => [key, retained[key]])),
      Object.fromEntries(runtimeIdentity.map((key) => [key, facts[key]])),
      "Retained directory watch projection changed",
    );
    assert(
      spec.heartbeatWorkers?.some(
        (contract) =>
          contract.inventorySha256 === retained.inventorySha256 &&
          contract.sourceCommit === retained.sourceCommit,
      ),
    );
    assert(
      source(
        retained.sourceRoot,
        retained.sourceRootIdentity,
        retained.manifestSha256,
        producer.pid,
        producer.time,
      ),
    );
  }
  assert(
    !rows.some((row) => row.event === "startup" && row.pid === created.child),
    "Sanitized directory watch unexpectedly inherited a preload",
  );
  return { role: "directory-watch", reason: "closed-helper-lifetime", sha256: facts.closureSha256 };
}
