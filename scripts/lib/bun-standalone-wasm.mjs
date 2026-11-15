import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Browser-owned WASM and independent child runtimes are not part of this host VM.
const HOST_WASM = new Set([
  "photon_rs_bg.wasm",
  "pdfium.esm.wasm",
  "web-tree-sitter.wasm",
  "tree-sitter-bash.wasm",
  "quickjs.wasm",
  "encoding.so",
  "matrix_sdk_crypto_wasm_bg.wasm",
  "archive-parser.wasm",
  "webp_codec.wasm",
]);

function walk(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, visit));
    } else if (value && typeof value === "object") {
      walk(value, visit);
    }
  }
}

// libopus-wasm 0.4.1 exposes only an Emscripten single-file payload. Decode at build
// time without evaluating package code; reject a changed decoder instead of registering
// different bytes from those consumed by the existing runtime loader.
function inlineOpusBytes(filename, parse) {
  const source = fs.readFileSync(filename, "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let decoder;
  let payload;
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration") {
      return;
    }
    if (node.id?.name === "binaryDecode") {
      decoder = node;
    }
    if (node.id?.name !== "findWasmBinary") {
      return;
    }
    const [statement] = node.body.body;
    const expression = statement?.argument;
    if (
      node.body.body.length === 1 &&
      statement.type === "ReturnStatement" &&
      expression?.type === "CallExpression" &&
      expression.callee.type === "Identifier" &&
      expression.callee.name === "binaryDecode" &&
      expression.arguments.length === 1 &&
      expression.arguments[0].type === "Literal" &&
      typeof expression.arguments[0].value === "string"
    ) {
      payload = expression.arguments[0].value;
    }
  });
  const expected =
    "functionbinaryDecode(bin){for(vari=0,l=bin.length,o=newUint8Array(l),c;i<l;++i){c=bin.charCodeAt(i);o[i]=~c>>8&c}returno}";
  if (
    !decoder ||
    source.slice(decoder.start, decoder.end).replace(/\s+/g, "") !== expected ||
    !payload
  ) {
    throw new Error(
      `Unsupported libopus-wasm inline payload in ${filename}; expose its raw WASM asset or update the build decoder contract.`,
    );
  }
  const bytes = new Uint8Array(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    bytes[index] = (~code >> 8) & code;
  }
  return bytes;
}

/**
 * Register only resources retained by the sidecar owner. The final compiler sees
 * literal .wasm imports while runtime libraries keep their own read/instantiate path.
 * @param {{ resources: { source: string, destination: string }[], outputRoot: string, parse: typeof import("acorn").parse }} options
 */
export function prepareStandaloneWasm({ resources, outputRoot, parse }) {
  /** @type {{ source: string, sha256: string, sizeBytes: number }[]} */
  const assets = [];
  const modules = new Map();
  const register = (source, bytes) => {
    if (!WebAssembly.validate(bytes)) {
      throw new Error(`Invalid standalone WASM resource: ${source}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    modules.set(sha256, bytes);
    assets.push({ source, sha256, sizeBytes: bytes.length });
  };
  for (const resource of resources.toSorted((left, right) =>
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
  )) {
    if (HOST_WASM.has(path.basename(resource.destination))) {
      register(resource.destination, fs.readFileSync(resource.source));
    } else if (
      path.posix.basename(path.posix.dirname(resource.destination)) === "libopus-wasm" &&
      path.basename(resource.destination) === "package.json"
    ) {
      const manifest = JSON.parse(fs.readFileSync(resource.source, "utf8"));
      if (manifest.name !== "libopus-wasm") {
        continue;
      }
      const entry = "dist/generated/libopus.generated.mjs";
      register(
        path.posix.join(path.posix.dirname(resource.destination), entry),
        inlineOpusBytes(path.join(path.dirname(resource.source), entry), parse),
      );
    }
  }
  if (!modules.size) {
    return { assets, registrationPath: undefined };
  }
  const directory = path.join(outputRoot, "wasm");
  fs.mkdirSync(directory, { recursive: true });
  const imports = [];
  for (const [sha256, bytes] of modules) {
    const name = `${sha256}.wasm`;
    fs.writeFileSync(path.join(directory, name), bytes);
    imports.push(`import ${JSON.stringify(`./wasm/${name}`)};`);
  }
  const registration = imports.join("\n") + "\n";
  // Importing entries are fingerprinted; their paths must capture every WASM byte change.
  const registrationSha256 = createHash("sha256").update(registration).digest("hex");
  const registrationPath = path.join(outputRoot, `standalone-wasm-${registrationSha256}.mjs`);
  fs.writeFileSync(registrationPath, registration);
  return { assets, registrationPath };
}

/** Keep the temporary build root out of the graph's content fingerprint. */
export function standaloneWasmImport(filename, registrationPath) {
  const relative = path
    .relative(path.dirname(filename), registrationPath)
    .split(path.sep)
    .join("/");
  return `import ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};\n`;
}
