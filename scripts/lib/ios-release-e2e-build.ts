import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_CACHE_VERSION,
  acquireBuildArtifactLockAsync,
  listCacheFiles,
  portableRelativePath,
  readArtifactRecord,
  writeArtifactRecord,
} from "./build-artifact-cache.mts";

export type IOSReleaseNativeBuildIdentity = {
  sourceSha: string;
  checkoutPath: string;
  xcodeVersion: string;
  sdkVersion: string;
  developerDir: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  buildArgs: string[];
  generatorArgs: string[];
};

const REQUIRED_PRODUCTS = [
  "Debug-iphonesimulator/OpenClaw.app/Info.plist",
  "Debug-iphonesimulator/OpenClaw.app/OpenClaw",
  "Debug-iphonesimulator/OpenClawUITests-Runner.app/Info.plist",
  "Debug-iphonesimulator/OpenClawUITests-Runner.app/OpenClawUITests-Runner",
  "Debug-iphonesimulator/OpenClawUITests-Runner.app/PlugIns/OpenClawUITests.xctest/Info.plist",
  "Debug-iphonesimulator/OpenClawUITests-Runner.app/PlugIns/OpenClawUITests.xctest/OpenClawUITests",
];

function productInventory(derivedDataPath: string) {
  const products = path.join(derivedDataPath, "Build/Products");
  for (const directory of [derivedDataPath, path.join(derivedDataPath, "Build"), products]) {
    if (!fs.lstatSync(directory).isDirectory()) {
      throw new Error("native-build-products-unavailable");
    }
  }
  const topology: string[][] = [];
  // The shared byte inventory excludes symlinks. Xcode bundles also need their
  // link targets, directory membership and executable modes bound to the receipt.
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).toSorted()) {
      const file = path.join(directory, name);
      const relative = portableRelativePath(products, file);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        const resolved = path.relative(products, target);
        if (
          resolved === ".." ||
          resolved.startsWith(`..${path.sep}`) ||
          path.isAbsolute(resolved)
        ) {
          throw new Error("native-build-external-product-link");
        }
        topology.push([relative, "link", fs.readlinkSync(file)]);
      } else if (stat.isDirectory()) {
        topology.push([relative, "directory", String(stat.mode & 0o777)]);
        visit(file);
      } else if (stat.isFile()) {
        topology.push([relative, "file", String(stat.mode & 0o777)]);
      } else {
        throw new Error("native-build-unsupported-product");
      }
    }
  };
  visit(products);
  const outputs = Object.fromEntries(
    listCacheFiles(products, ["."], fs).map((file) => [
      portableRelativePath(products, file),
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    ]),
  );
  const testRuns = Object.keys(outputs).filter(
    (file) => !file.includes("/") && file.endsWith(".xctestrun"),
  );
  if (testRuns.length !== 1 || REQUIRED_PRODUCTS.some((file) => !Object.hasOwn(outputs, file))) {
    throw new Error("native-build-products-incomplete");
  }
  return { outputs, topology, xctestrunPath: path.join(products, testRuns[0]!) };
}

/** Caller owns source/toolchain admission, build commands, and retained-directory cleanup. */
export async function prepareIOSReleaseNativeBuild(options: {
  buildDir: string;
  identity: IOSReleaseNativeBuildIdentity;
  assertCurrentSource: () => Promise<void>;
  build: (derivedDataPath: string) => Promise<void>;
}): Promise<{ derivedDataPath: string; xctestrunPath: string; reused: boolean }> {
  const { identity } = options;
  if (!/^[a-f0-9]{40}$/u.test(identity.sourceSha)) {
    throw new Error("native-build-invalid-source");
  }
  fs.mkdirSync(options.buildDir, { recursive: true, mode: 0o700 });
  const buildDir = fs.realpathSync(options.buildDir);
  const derivedDataPath = path.join(buildDir, "DerivedData");
  const receiptPath = path.join(buildDir, "native-build.json");
  // Keep the transient lock outside the admitted empty directory. The lock owner
  // joins the entire build callback before another invocation can inspect it.
  const lock = await acquireBuildArtifactLockAsync(`${buildDir}.native-build`);
  try {
    await options.assertCurrentSource();
    const entries = fs.readdirSync(buildDir);
    const reused = entries.includes("native-build.json");
    if (!reused) {
      if (entries.length !== 0) {
        throw new Error("native-build-incomplete-directory");
      }
      await options.build(derivedDataPath);
    } else if (!fs.lstatSync(receiptPath).isFile()) {
      throw new Error("native-build-invalid-receipt");
    }
    await options.assertCurrentSource();
    const inventory = productInventory(derivedDataPath);
    const signature = createHash("sha256")
      .update(
        JSON.stringify([
          "ios-release-native-build-v1",
          buildDir,
          fs.realpathSync(identity.checkoutPath),
          identity.sourceSha,
          identity.xcodeVersion,
          identity.sdkVersion,
          identity.developerDir,
          identity.nodeVersion,
          identity.platform,
          identity.arch,
          identity.buildArgs,
          identity.generatorArgs,
          inventory.topology,
        ]),
      )
      .digest("hex");
    if (reused) {
      const record = readArtifactRecord(receiptPath);
      if (
        !record ||
        record.signature !== signature ||
        Object.keys(record.outputs).length !== Object.keys(inventory.outputs).length ||
        Object.entries(inventory.outputs).some(([file, digest]) => record.outputs[file] !== digest)
      ) {
        throw new Error("native-build-receipt-mismatch");
      }
    } else {
      writeArtifactRecord(receiptPath, {
        version: ARTIFACT_CACHE_VERSION,
        signature,
        outputs: inventory.outputs,
      });
      fs.chmodSync(receiptPath, 0o600);
    }
    return { derivedDataPath, xctestrunPath: inventory.xctestrunPath, reused };
  } finally {
    await lock.release();
  }
}
