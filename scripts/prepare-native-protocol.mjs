#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const inputManifest = path.join(root, "scripts/native-protocol-inputs.json");
export const nativeProtocolOutputDirectories = {
  swift: "apps/shared/OpenClawKit/.build/protocol",
  kotlin: "apps/android/gateway-client/build/generated/openclaw-protocol",
};
const outputFiles = {
  swift: ["GatewayModels.swift"],
  kotlin: [
    "ai/openclaw/app/gateway/GatewayProtocol.kt",
    "ai/openclaw/app/protocol/OpenClawProtocolConstants.kt",
  ],
};

function listInputs() {
  const { directories, files } = JSON.parse(fs.readFileSync(inputManifest, "utf8"));
  const inputs = new Set(files);
  for (const directory of directories) {
    for (const entry of fs.readdirSync(path.join(root, directory), { recursive: true })) {
      if (/\.(?:ts|mts|mjs|json)$/.test(entry) && !/\.(?:test|spec)\./.test(entry)) {
        inputs.add(path.posix.join(directory, entry.split(path.sep).join("/")));
      }
    }
  }
  return [...inputs].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function fingerprint(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0").update(fs.readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

export async function prepareNativeProtocol({ language = "all", out, check = false } = {}) {
  if (!fs.existsSync(path.join(root, "packages/gateway-protocol/src/schema/protocol-schemas.ts"))) {
    // Published CLI packages do not contain native source or generator dependencies.
    return;
  }
  if (!["all", "swift", "kotlin"].includes(language) || (out && language === "all")) {
    throw new Error("Choose --language swift or kotlin when using --out");
  }
  const inputs = listInputs();
  const inputHash = fingerprint(inputs.map((file) => path.join(root, file)));
  const languages = language === "all" ? ["swift", "kotlin"] : [language];
  let generator;
  for (const selected of languages) {
    const directory = path.resolve(root, out ?? nativeProtocolOutputDirectories[selected]);
    const outputs = outputFiles[selected].map((file) => path.join(directory, file));
    const cache = path.join(directory, ".cache");
    const stamp = path.join(cache, "native-protocol.sha256");
    if (!check && fs.existsSync(stamp) && outputs.every((file) => fs.existsSync(file))) {
      if (fs.readFileSync(stamp, "utf8") === `${inputHash}:${fingerprint(outputs)}\n`) {
        continue;
      }
    }
    fs.mkdirSync(cache, { recursive: true });
    if (!generator) {
      const require = createRequire(path.join(root, "packages/gateway-protocol/package.json"));
      const { build } = require("esbuild");
      const bundle = await build({
        absWorkingDir: root,
        entryPoints: ["packages/gateway-protocol/scripts/native-codegen.ts"],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        write: false,
        metafile: true,
      });
      const declaredInputs = new Set(inputs);
      for (const file of Object.keys(bundle.metafile.inputs)) {
        if (!file.includes("node_modules/") && !declaredInputs.has(file)) {
          throw new Error(
            `Native protocol input ${file} is missing from scripts/native-protocol-inputs.json`,
          );
        }
      }
      const bundlePath = path.join(cache, `generator-${randomUUID()}.mjs`);
      fs.writeFileSync(bundlePath, bundle.outputFiles[0].contents);
      try {
        generator = await import(pathToFileURL(bundlePath).href);
      } finally {
        fs.unlinkSync(bundlePath);
      }
    }
    const generated = await generator.generateNativeProtocol(root, selected);
    generator.assertNativeProtocolContract(selected, generated);
    if (check) {
      const repeated = await generator.generateNativeProtocol(root, selected);
      if (JSON.stringify(generated) !== JSON.stringify(repeated)) {
        throw new Error(`${selected} protocol generation is not deterministic`);
      }
    }
    for (const [file, content] of Object.entries(generated)) {
      writeTextFileIfChanged(path.join(directory, file), content);
    }
    writeTextFileIfChanged(stamp, `${inputHash}:${fingerprint(outputs)}\n`);
    console.log(
      `[native-protocol] ${selected}: ${check ? "contract and determinism checked" : "generated"}`,
    );
  }
}

if (import.meta.main) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if ((arg === "--language" || arg === "--out") && process.argv[index + 1]) {
      options[arg === "--language" ? "language" : "out"] = process.argv[++index];
    } else {
      throw new Error(`Unknown or incomplete native protocol argument: ${arg}`);
    }
  }
  await prepareNativeProtocol(options);
}
