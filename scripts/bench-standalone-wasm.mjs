#!/usr/bin/env node
// Small dependency workloads only: never compiles or starts OpenClaw.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { prepareStandaloneWasm } from "./lib/bun-standalone-wasm.mjs";

const [bun, destination, repository = process.cwd()] = process.argv.slice(2);
if (!bun || !destination) {
  throw new Error(
    "Usage: node scripts/bench-standalone-wasm.mjs <aot-bun> <fresh-output-directory> [repository-root]",
  );
}
const output = path.resolve(destination);
fs.mkdirSync(output);
const repo = path.resolve(repository);
const samples = 5;
const packageRoot = (name, parent = repo) => {
  const require = createRequire(path.join(parent, "package.json"));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = path.join(search, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
  }
  throw new Error(
    `Missing benchmark dependency ${name} from ${parent}; install the workspace first.`,
  );
};
const rootPackage = (name, plugin) =>
  packageRoot(name, plugin ? path.join(repo, "extensions", plugin) : repo);
const opus = rootPackage("libopus-wasm", "discord");
const photon = packageRoot("@silvia-odwyer/photon-node", rootPackage("rastermill"));
const pdf = rootPackage("clawpdf", "document-extract");
const tree = rootPackage("web-tree-sitter");
const bash = rootPackage("tree-sitter-bash");
const quickjs = rootPackage("quickjs-wasi", "code-mode-quickjs");
const matrix = packageRoot(
  "@matrix-org/matrix-sdk-crypto-wasm",
  rootPackage("matrix-js-sdk", "matrix"),
);
const tar = rootPackage("@openclaw/fs-safe");

// Preserve the installed library's disk-relative reads in a compiled probe, just
// as the standalone resource adapter does. Computational code is unchanged.
function diskLoader(filename, name) {
  let source = fs.readFileSync(filename, "utf8");
  source = source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href));
  source = source.replaceAll(/\b__dirname\b/g, JSON.stringify(path.dirname(filename)));
  source = source.replace(
    /(from\s*["'])(\.[^"']+)(["'])/g,
    (_match, prefix, specifier, suffix) =>
      `${prefix}${path.resolve(path.dirname(filename), specifier)}${suffix}`,
  );
  const target = path.join(output, name);
  fs.writeFileSync(target, source);
  return target;
}
const photonLoader = diskLoader(path.join(photon, "photon_rs.js"), "photon.cjs");
const matrixLoader = diskLoader(path.join(matrix, "node.mjs"), "matrix.mjs");
const tarLoader = diskLoader(path.join(tar, "dist/archive-tar-wasm.js"), "tar.mjs");
const q = JSON.stringify;
const prelude = `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
const start = performance.now(); const startCpu = process.cpuUsage();
function initialized() { const cpu = process.cpuUsage(startCpu); console.log(JSON.stringify({ phase: "init", ms: performance.now()-start, cpuMs: (cpu.user+cpu.system)/1000 })); }
function measure(run, iterations, summarize = (value) => value) {
  let result; for(let i=0;i<2;i++) result=run();
  const start=performance.now();const cpu=process.cpuUsage();
  for(let i=0;i<iterations;i++)result=run();
  const used=process.cpuUsage(cpu);const ms=performance.now()-start;console.log(JSON.stringify({phase:"work",ms,cpuMs:(used.user+used.system)/1000,result:summarize(result)}));
}
`;
function syntheticPdf() {
  const stream =
    "BT /F1 16 Tf 20 280 Td (Synthetic OpenClaw WASM probe) Tj ET\n" +
    Array.from({ length: 100 }, (_, i) => `${i % 200} ${i % 200} 10 10 re f`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    data += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return Buffer.from(
    data + `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
function syntheticTar() {
  const parts = [];
  for (let index = 0; index < 100; index++) {
    const data = Buffer.from(`synthetic-file-${index}-`.repeat(300));
    const header = Buffer.alloc(512);
    header.write(`folder/file-${index}.txt`);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
const pdfInput = path.join(output, "synthetic.pdf");
fs.writeFileSync(pdfInput, syntheticPdf());
const tarInput = path.join(output, "synthetic.tar");
fs.writeFileSync(tarInput, syntheticTar());
const workloads = {
  opus: {
    root: opus,
    assets: [],
    inline: true,
    source: `const {createEncoder,createDecoder}=await import(${q(path.join(opus, "dist/index.js"))});const encoder=await createEncoder({channels:2,sampleRate:48000,complexity:5});const decoder=await createDecoder({channels:2,sampleRate:48000});const pcm=Int16Array.from({length:1920},(_,i)=>Math.round(Math.sin(i*2*Math.PI*440/48000)*10000));initialized();measure(()=>{const packet=encoder.encode(pcm);return decoder.decode(packet);},100,sha256);encoder.free();decoder.free();`,
  },
  photon: {
    root: photon,
    assets: ["photon_rs_bg.wasm"],
    source: `const {default:photon}=await import(${q(photonLoader)});const pixels=Uint8Array.from({length:256*256*4},(_,i)=>(i*37)%256);initialized();measure(()=>{const image=new photon.PhotonImage(pixels,256,256);const resized=photon.resize(image,128,128,1);try{return resized.get_bytes();}finally{image.free();resized.free();}},10,sha256);`,
  },
  pdf: {
    root: pdf,
    assets: ["dist/vendor/pdfium.esm.wasm"],
    source: `const {createEngine}=await import(${q(path.join(pdf, "dist/index.js"))});const engine=await createEngine({wasmBinary:readFileSync(${q(path.join(pdf, "dist/vendor/pdfium.esm.wasm"))})});const document=await engine.open(readFileSync(${q(pdfInput)}));const page=document.page(1);initialized();measure(()=>{const text=page.text();const rendered=page.render({width:300});return {text,rgba:rendered.rgba};},5,(result)=>({text:sha256(result.text),rgba:sha256(result.rgba)}));document.destroy();await engine.destroy();`,
  },
  tree: {
    root: tree,
    assets: ["web-tree-sitter.wasm"],
    extra: [
      {
        source: path.join(bash, "tree-sitter-bash.wasm"),
        destination: "assets/tree-sitter-bash.wasm",
      },
    ],
    source: `const {Parser,Language}=await import(${q(path.join(tree, "web-tree-sitter.js"))});await Parser.init({locateFile:()=>${q(path.join(tree, "web-tree-sitter.wasm"))}});const language=await Language.load(${q(path.join(bash, "tree-sitter-bash.wasm"))});const parser=new Parser().setLanguage(language);const source='for item in a b c; do printf "%s\\\\n" "$item" | sed s/a/b/g; done\\n'.repeat(30);initialized();measure(()=>{const tree=parser.parse(source);try{return tree.rootNode.toString();}finally{tree.delete();}},10,sha256);parser.delete();`,
  },
  quickjs: {
    root: quickjs,
    assets: ["quickjs.wasm", "extensions/encoding/encoding.so"],
    source: `const {QuickJS}=await import(${q(path.join(quickjs, "dist/index.js"))});const wasm=await WebAssembly.compile(readFileSync(${q(path.join(quickjs, "quickjs.wasm"))}));const encoding=await WebAssembly.compile(readFileSync(${q(path.join(quickjs, "extensions/encoding/encoding.so"))}));const vm=await QuickJS.create({wasm,extensions:[{name:"encoding",wasm:encoding}]});initialized();measure(()=>{const value=vm.evalCode('(()=>{let total=0;for(let i=0;i<10000;i++)total+=i;return total+new TextEncoder().encode("probe").length;})()');try{return value.toNumber();}finally{value.dispose();}},10);vm.dispose();`,
  },
  matrix: {
    root: matrix,
    assets: ["pkg/matrix_sdk_crypto_wasm_bg.wasm"],
    source: `const {initAsync,PkDecryption,PkEncryption}=await import(${q(matrixLoader)});await initAsync();const decryptor=new PkDecryption();const key=decryptor.publicKey();const encryptor=PkEncryption.fromKey(key);const source="synthetic-matrix-backup-".repeat(200);initialized();measure(()=>{const message=encryptor.encryptString(source);try{const result=decryptor.decryptString(message);if(result!==source)throw new Error("roundtrip mismatch");return result;}finally{message.free();}},30,sha256);encryptor.free();key.free();decryptor.free();`,
  },
  tar: {
    root: tar,
    assets: ["dist/archive-parser.wasm"],
    source: `const {TarWasmSession}=await import(${q(tarLoader)});const bytes=readFileSync(${q(tarInput)});const limits={maxEntries:1000,maxMetaEntryBytes:1048576,maxDecodedBytes:10000000,maxManifestBytes:10000000};initialized();measure(()=>{const session=new TarWasmSession(limits);const entries=[];try{session.parse(bytes,(member)=>entries.push(member));session.finish();return entries;}finally{session.dispose();}},10,(entries)=>sha256(JSON.stringify(entries)));`,
  },
};
workloads["quickjs-worker"] = {
  root: quickjs,
  assets: ["quickjs.wasm", "extensions/encoding/encoding.so"],
  source: `const {Worker,isMainThread,parentPort,workerData}=await import("node:worker_threads");
if(isMainThread){
  const wasm=await WebAssembly.compile(readFileSync(${q(path.join(quickjs, "quickjs.wasm"))}));
  const encoding=await WebAssembly.compile(readFileSync(${q(path.join(quickjs, "extensions/encoding/encoding.so"))}));
  const worker=new Worker(new URL(import.meta.url),{workerData:{wasm,encoding}});
  await new Promise((resolve,reject)=>{worker.once("exit",(code)=>code===0?resolve():reject(new Error("worker exited "+code)));worker.once("error",reject);});
}else{
  const {QuickJS}=await import(${q(path.join(quickjs, "dist/index.js"))});
  const vm=await QuickJS.create({wasm:workerData.wasm,extensions:[{name:"encoding",wasm:workerData.encoding}]});
  initialized();measure(()=>{const value=vm.evalCode('(()=>{let total=0;for(let i=0;i<10000;i++)total+=i;return total+new TextEncoder().encode("probe").length;})()');try{return value.toNumber();}finally{value.dispose();}},10);
  vm.dispose();parentPort.close();
}`,
};
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
  }
  return result.stdout;
}
const built = [];
for (const [name, workload] of Object.entries(workloads)) {
  const directory = path.join(output, name);
  fs.mkdirSync(directory);
  const resources = workload.assets.map((asset) => ({
    source: path.join(workload.root, asset),
    destination: `assets/${asset}`,
  }));
  resources.push(...(workload.extra ?? []));
  if (workload.inline) {
    resources.push({
      source: path.join(workload.root, "package.json"),
      destination: "native/libopus-wasm/package.json",
    });
  }
  const registration = prepareStandaloneWasm({ resources, outputRoot: directory, parse });
  const before = path.join(directory, "before.mjs"),
    after = path.join(directory, "after.mjs");
  fs.writeFileSync(before, prelude + workload.source + "\n");
  fs.writeFileSync(
    after,
    `import ${q(registration.registrationPath)};\n` + prelude + workload.source + "\n",
  );
  for (const [mode, entry] of [
    ["before", before],
    ["after", after],
  ]) {
    run(bun, ["compile", entry, "--outfile", path.join(directory, mode)]);
  }
  built.push({
    name,
    directory,
    before,
    after,
    assets: registration.assets,
    binaryBytes: {
      before: fs.statSync(path.join(directory, "before")).size,
      after: fs.statSync(path.join(directory, "after")).size,
    },
  });
  console.log(`Prepared ${name}`);
}
const report = {
  bun: run(bun, ["--version"]).trim(),
  platform: process.platform,
  arch: process.arch,
  loadAverage: os.loadavg(),
  samples,
  rule: "All workload results must match; AOT registered warm CPU must improve over dynamic AOT. JIT and cold-start numbers are controls.",
  workloads: [],
};
for (const workload of built) {
  const rows = [];
  let expected;
  for (let sample = 0; sample < samples; sample++) {
    for (const mode of ["jit-before", "aot-before", "jit-after", "aot-after"]) {
      const suffix = mode.endsWith("before") ? "before" : "after";
      const jit = mode.startsWith("jit");
      const processStart = performance.now();
      const stdout = jit
        ? run(bun, [path.join(workload.directory, `${suffix}.mjs`)])
        : run(path.join(workload.directory, suffix), []);
      const phases = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const work = phases.find((row) => row.phase === "work");
      const init = phases.find((row) => row.phase === "init");
      const result = q(work.result);
      expected ??= result;
      if (result !== expected) {
        throw new Error(`${workload.name} result mismatch in ${mode}: ${result} != ${expected}`);
      }
      rows.push({ sample, mode, init, work, processMs: performance.now() - processStart });
    }
  }
  const summaries = Object.fromEntries(
    ["jit-before", "aot-before", "jit-after", "aot-after"].map((mode) => {
      const values = rows.filter((row) => row.mode === mode);
      const stats = (phase, key) => {
        const sorted = values.map((row) => row[phase][key]).toSorted((a, b) => a - b);
        return {
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          min: sorted[0],
          max: sorted.at(-1),
        };
      };
      return [
        mode,
        {
          processMs: (() => {
            const sorted = values.map((row) => row.processMs).toSorted((a, b) => a - b);
            return { median: sorted[2], p95: sorted[4], min: sorted[0], max: sorted[4] };
          })(),
          initMs: stats("init", "ms"),
          initCpuMs: stats("init", "cpuMs"),
          workMs: stats("work", "ms"),
          workCpuMs: stats("work", "cpuMs"),
        },
      ];
    }),
  );
  report.workloads.push({
    name: workload.name,
    assets: workload.assets,
    binaryBytes: workload.binaryBytes,
    result: JSON.parse(expected),
    summaries,
    rows,
  });
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    `${workload.name}: dynamic AOT ${summaries["aot-before"].workCpuMs.median.toFixed(2)}ms CPU -> registered AOT ${summaries["aot-after"].workCpuMs.median.toFixed(2)}ms CPU`,
  );
}
