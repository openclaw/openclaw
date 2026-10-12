import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
const TOOLING_ROOT = "file:///__openclaw_verified_tooling__/",
  YAML_ROOT = "file:///__openclaw_verified_yaml__/";
const YAML_ABSOLUTE_ROOT = "/__openclaw_verified_yaml__",
  CORE_PATH = "scripts/release-plan-producer-core.mts";
const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
/** @returns {never} */
const fail = (message) => {
  throw new Error(message);
};
const decodeBase64 = (value) => {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    fail("verified retained bytes are not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail("verified retained bytes are not canonical base64");
  }
  return bytes;
};
const toolingUrl = (path) => new URL(path, TOOLING_ROOT).href,
  yamlUrl = (path) => new URL(path, YAML_ROOT).href;
const safePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  /^[\x20-\x7e]+$/.test(path) &&
  !path.includes("\\") &&
  !path.startsWith("/") &&
  !path.split("/").some((part) => part === "." || part === "..");
try {
  const payload = JSON.parse(readFileSync(0, "utf8")),
    expectedPaths = [...payload.expectedToolingPaths].toSorted(compareAscii);
  if (
    !Array.isArray(payload.toolingModules) ||
    payload.toolingModules.length !== expectedPaths.length
  ) {
    fail("verified tooling module set is incomplete");
  }
  const toolingModules = new Map();
  for (const record of payload.toolingModules) {
    if (
      !record ||
      !expectedPaths.includes(record.path) ||
      toolingModules.has(record.path) ||
      !Array.isArray(record.imports)
    ) {
      fail("verified tooling module record is invalid");
    }
    toolingModules.set(record.path, {
      bytes: decodeBase64(record.bytesBase64),
      format: record.path.endsWith(".mjs") ? "module" : "module-typescript",
      imports: new Map(record.imports),
    });
  }
  if (
    [...toolingModules.keys()]
      .toSorted(compareAscii)
      .some((path, index) => path !== expectedPaths[index])
  ) {
    fail("verified tooling module paths do not match the allowlist");
  }
  if (!Array.isArray(payload.yamlEntries) || payload.yamlEntries.length > 1024) {
    fail("verified yaml retained tree has too many entries");
  }
  const yamlModules = new Map(),
    yamlRecords = [];
  let yamlFiles = 0,
    yamlBytes = 0;
  for (const entry of payload.yamlEntries) {
    if (!entry || !safePath(entry.path)) {
      fail("verified yaml retained tree contains an unsafe path");
    }
    if (entry.kind === "directory") {
      yamlRecords.push(JSON.stringify(["directory", entry.path]));
      continue;
    }
    if (entry.kind !== "file" || yamlModules.has(entry.path)) {
      fail("verified yaml retained tree contains an invalid entry");
    }
    const bytes = decodeBase64(entry.bytesBase64);
    yamlFiles += 1;
    yamlBytes += bytes.byteLength;
    if (yamlFiles > 512 || yamlBytes > 4194304) {
      fail("verified yaml retained tree exceeds its bounds");
    }
    yamlModules.set(entry.path, bytes);
    yamlRecords.push(
      JSON.stringify([
        "file",
        entry.path,
        bytes.byteLength,
        createHash("sha256").update(bytes).digest("hex"),
      ]),
    );
  }
  const yamlManifest = yamlRecords.toSorted(compareAscii).join("\n") + "\n";
  if (
    createHash("sha256").update(yamlManifest, "ascii").digest("hex") !==
    "0bdabef304b977ea9eea35e0ecb51e85d1450f4c1ed0bb3c93010ccecdde7779"
  ) {
    fail("verified yaml retained tree digest mismatch");
  }
  const packageBytes = yamlModules.get("package.json");
  if (!packageBytes) {
    fail("verified yaml retained package.json is missing");
  }
  const yamlPackage = JSON.parse(packageBytes.toString("utf8"));
  if (yamlPackage.name !== "yaml" || yamlPackage.version !== "2.9.1") {
    fail("verified yaml retained package identity mismatch");
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      if (context.parentURL?.startsWith(TOOLING_ROOT)) {
        const parentPath = context.parentURL.slice(TOOLING_ROOT.length);
        const targetPath = toolingModules.get(parentPath)?.imports.get(specifier);
        if (!targetPath) {
          fail("verified tooling import is not allowlisted");
        }
        return {
          url: toolingUrl(targetPath),
          format: toolingModules.get(targetPath).format,
          shortCircuit: true,
        };
      }
      if (specifier === toolingUrl(CORE_PATH)) {
        return { url: specifier, format: toolingModules.get(CORE_PATH).format, shortCircuit: true };
      }
      const targetUrl = specifier.startsWith(YAML_ABSOLUTE_ROOT + "/")
        ? yamlUrl(specifier.slice(YAML_ABSOLUTE_ROOT.length + 1))
        : context.parentURL?.startsWith(YAML_ROOT) && specifier.startsWith(".")
          ? new URL(specifier, context.parentURL).href
          : undefined;
      if (targetUrl) {
        const targetPath = targetUrl.slice(YAML_ROOT.length);
        if (!yamlModules.has(targetPath)) {
          fail("verified yaml import is not retained");
        }
        return { url: targetUrl, format: "commonjs", shortCircuit: true };
      }
      return fail("verified child rejected an external module import");
    },
    load(url, context, nextLoad) {
      if (url.startsWith(TOOLING_ROOT)) {
        const record = toolingModules.get(url.slice(TOOLING_ROOT.length));
        if (!record) {
          fail("verified tooling module is not retained");
        }
        return { format: record.format, source: record.bytes, shortCircuit: true };
      }
      if (url.startsWith(YAML_ROOT)) {
        const bytes = yamlModules.get(url.slice(YAML_ROOT.length));
        if (!bytes) {
          fail("verified yaml module is not retained");
        }
        return { format: "commonjs", source: bytes, shortCircuit: true };
      }
      if (url.startsWith("node:")) {
        return nextLoad(url, context);
      }
      return fail("verified child rejected an external module load");
    },
  });
  if (
    !Array.isArray(payload.identityResponses) ||
    payload.identityResponses.length < 1 ||
    payload.identityResponses.length > 32
  ) {
    fail("verified identity response cache is invalid");
  }
  const identityResponses = new Map();
  for (const [key, response] of payload.identityResponses) {
    if (
      typeof key !== "string" ||
      !response ||
      !["text", "base64"].includes(response.encoding) ||
      typeof response.body !== "string"
    ) {
      fail("verified identity response is invalid");
    }
    const entries = identityResponses.get(key) ?? [];
    entries.push(response.encoding === "text" ? response.body : decodeBase64(response.body));
    identityResponses.set(key, entries);
  }
  const response = (args) => {
    const entries = identityResponses.get(JSON.stringify(args));
    if (!entries?.length) {
      fail("verified child rejected an uncached GitHub request");
    }
    return entries.shift();
  };
  const runGh = (args) => {
    const value = response(args);
    if (typeof value !== "string") {
      fail("verified identity JSON request received binary data");
    }
    return value;
  };
  const downloadArchive = (args) => {
    const value = response(args);
    if (!Buffer.isBuffer(value)) {
      fail("verified identity archive request received text");
    }
    return value;
  };
  let parseYaml;
  const parseYamlDocuments = (sources) => {
    if (
      !Array.isArray(sources) ||
      sources.length !== 3 ||
      sources.some((value) => typeof value !== "string")
    ) {
      fail("verified yaml parser input must contain three workflow strings");
    }
    if (!parseYaml) {
      const yaml = createRequire(import.meta.url)(YAML_ABSOLUTE_ROOT + "/dist/index.js");
      if (typeof yaml.parse !== "function") {
        fail("verified yaml parser must export parse");
      }
      parseYaml = yaml.parse;
    }
    return sources.map(parseYaml);
  };
  const core = await import(toolingUrl(CORE_PATH)),
    value = core.runReleasePlanProducerOperation(payload.request, {
      runGh,
      downloadArchive,
      parseYamlDocuments,
    });
  if ([...identityResponses.values()].some((entries) => entries.length !== 0)) {
    fail("verified child did not consume complete identity evidence");
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
}
