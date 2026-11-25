// Complete profiling boundary functions; procfs/systemd/filesystem replies are synthetic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const library = readFileSync(new URL("./release-lib.mjs", import.meta.url), "utf8");
const preload = readFileSync(new URL("./startup-profile.mjs", import.meta.url), "utf8");
const group = "/system.slice/openclaw-gateway.service";
const cases = [
  [group, true], [group + "/gateway", true], [group + "/other", false],
  [group + "/gateway/sandbox-x", false], ["/system.slice/other.service/gateway", false],
];
function definition(source, name, indent = "") {
  const start = source.indexOf(`${indent}function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf(`\n${indent}}`, start);
  assert(end > start, name);
  return source.slice(start, end + indent.length + 2);
}

// Profile admission independently rechecks the managed process after systemd starts it.
test("profiling admission accepts only the unit root and exact Gateway leaf", () => {
  const constants = library.slice(library.indexOf("const repairNativeUnit ="), library.indexOf("const repairNativeLibrary ="));
  const helper = library.includes("function repairNativeProcessCgroup(")
    ? definition(library, "repairNativeProcessCgroup") : "";
  for (const [observed, allowed] of cases) {
    const invoke = () => runInNewContext(`${constants}\n${helper}\n${definition(library, "processBinding", "  ")}\nprocessBinding({cgroup: group, uid: 1000, operation: 'profile'}, 123, '456');`, {
      assert, Buffer, group, process: { execPath: "/usr/bin/node" },
      systemProperty: name => name === "MainPID" ? 123 : Buffer.from("a".repeat(32), "hex"),
      generation: () => "456",
      initialEnvironment: () => new Map([["INVOCATION_ID", "a".repeat(32)], ["SYSTEMD_EXEC_PID", "123"]]),
      statSync: () => ({ uid: 1000 }), realpathSync: () => "/usr/bin/node",
      readFileSync: () => `0::${observed}\n`, reject: message => { throw new Error(message); },
    });
    if (allowed) assert.equal(invoke().pid, 123, observed);
    else assert.throws(invoke, undefined, observed);
  }
});

// The bootstrap runs before Gateway entry: DelegateSubgroup already places ExecStart in /gateway.
test("profiling bootstrap claims only the unit root and exact Gateway leaf", async () => {
  const start = preload.indexOf("async function runPreload() {"), end = preload.indexOf("\nexport function profileFacts", start);
  assert(start >= 0 && end > start);
  for (const [observed, allowed] of cases) {
    const writes = new Map(), events = [];
    const intent = { bootId: "boot", cgroup: group, entry: "/release/dist/index.js", entryMetadata: {},
      expiresMicros: 120_000_000, gid: 1000, node: {}, nodeVersion: "v24.0.0", operation: "profile",
      owner: { pid: 456, start: "789" }, release: "/release", uid: 1000, mode: "steady", armedUntilMicros: 900_000_000 };
    const fields = Array(24).fill("0"); fields[0] = "S"; fields[19] = "789";
    const fs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
      lstatSync: () => ({ isDirectory: () => true, uid: 0, mode: 0o700 }),
      realpathSync: value => value,
      openSync: file => {
        if (file.endsWith("intent.json") || file.endsWith("bootstrap-claim.json")) return file;
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      fstatSync: () => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o600, size: 100 }),
      readFileSync: file => {
        if (file.endsWith("intent.json")) return JSON.stringify(intent);
        if (file.endsWith("/cgroup")) return `0::${observed}\n`;
        if (file.endsWith("/stat")) return `123 (node) ${fields.join(" ")}`;
        if (file.endsWith("boot_id")) return "boot\n";
        throw new Error(`unexpected read: ${file}`);
      },
      writeFileSync: (file, value) => writes.set(file, value), closeSync() {},
      appendFileSync: (_file, value) => events.push(JSON.parse(value)),
      watch: () => ({ once() {}, close() {} }),
    };
    await runInNewContext(`const process = {version:'v24.0.0', ppid:1, pid:123, getuid:()=>1000, getgid:()=>1000, env:{}, argv:['node','/release/dist/index.js','gateway','--port','18789'], cwd:()=>'/release'};\n${definition(preload, "runningOwner")}\n${preload.slice(start, end)}\nrunPreload();`, {
      assert, fs, path, directory: "/profile", mono: () => 1_000_000,
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
    });
    assert.equal(writes.has("/profile/spool/bootstrap-claim.json"), allowed, observed);
    assert.equal(events.some(event => event.event === "bootstrap.rejected"), !allowed, observed);
  }
});

// SourceTextModule preserves the privileged entry's import.meta URL check without a production seam.
test("systemd start condition accepts only the unit root and exact control leaf", () => {
  const constants = library.slice(library.indexOf("const repairNativeUnit ="), library.indexOf("const repairNativeProperties ="));
  const entry = `${constants}\n${definition(library, "retainedRepairStartClaim")}\nretainedRepairStartClaim('/root', 'operation');`;
  const script = `
import assert from "node:assert/strict";
import { createContext, SourceTextModule } from "node:vm";
import { fileURLToPath } from "node:url";
const group = ${JSON.stringify(group)}, entry = ${JSON.stringify(entry)};
for (const [observed, allowed] of [[group,true],[group+'/.control',true],[group+'/gateway',false],
    [group+'/other',false],[group+'/.control/sandbox-x',false],['/system.slice/other.service/.control',false]]) {
  let claimed = false;
  const context = createContext({
    process: {getuid:()=>0,geteuid:()=>0,ppid:1,pid:123,execPath:'/usr/bin/node',env:{INVOCATION_ID:'a'.repeat(32)}},
    fileURLToPath, realpathSync: value => value,
    repairNativeShow: () => ({ActiveState:'activating',SubState:'condition',MainPID:'0',ControlPID:'123',ControlGroup:group,InvocationID:'a'.repeat(32)}),
    readFileSync: () => '0::'+observed+'\\n', reject: message => {throw new Error(message);},
    repairNativeClaimCore: () => {claimed = true;},
  });
  const subject = new SourceTextModule(entry, {context, initializeImportMeta(meta) {meta.url='file:///usr/local/lib/openclaw-team/release-lib.mjs';}});
  await subject.link(() => {throw new Error('unexpected import');});
  if (allowed) await subject.evaluate();
  else await assert.rejects(subject.evaluate(), /repair claim is not this service/);
  assert.equal(claimed, allowed, observed);
}
`;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
