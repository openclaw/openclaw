import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const protoPath = path.join(repoRoot, "dist", "protocol.proto");
const outRoot = path.join(repoRoot, "dist", "connectors");

function hasCmd(bin: string): boolean {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { stdio: "ignore" });
  return r.status === 0;
}

function run(cmd: string): { ok: boolean; output: string } {
  const r = spawnSync("bash", ["-lc", cmd], { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

async function main() {
  if (!existsSync(protoPath)) {
    throw new Error(`missing ${protoPath}; run pnpm protocol:gen:proto first`);
  }

  await fs.mkdir(outRoot, { recursive: true });

  const notes: string[] = [];
  notes.push("# Connector generation report");
  notes.push("");
  notes.push(`Proto source: \`${path.relative(repoRoot, protoPath)}\``);
  notes.push("");

  // Always try descriptor set first.
  if (hasCmd("protoc")) {
    const descOut = path.join(outRoot, "protocol.pb");
    const cmd = `protoc --proto_path=${path.join(repoRoot, "dist")} --include_imports --descriptor_set_out=${descOut} ${protoPath}`;
    const res = run(cmd);
    notes.push(`- protoc descriptor set: ${res.ok ? "OK" : "FAILED"}`);
    if (!res.ok && res.output) {
      notes.push(`  - ${res.output.replace(/\n/g, "\n  - ")}`);
    }
  } else {
    notes.push("- protoc descriptor set: skipped (protoc not found)");
  }

  const targets = [
    {
      name: "python",
      cmd: `protoc --proto_path=${path.join(repoRoot, "dist")} --python_out=${path.join(outRoot, "python")} ${protoPath}`,
      needs: ["protoc"],
    },
    {
      name: "java",
      cmd: `protoc --proto_path=${path.join(repoRoot, "dist")} --java_out=${path.join(outRoot, "java")} ${protoPath}`,
      needs: ["protoc"],
    },
    {
      name: "csharp",
      cmd: `protoc --proto_path=${path.join(repoRoot, "dist")} --csharp_out=${path.join(outRoot, "csharp")} ${protoPath}`,
      needs: ["protoc"],
    },
    {
      name: "php",
      cmd: `protoc --proto_path=${path.join(repoRoot, "dist")} --php_out=${path.join(outRoot, "php")} ${protoPath}`,
      needs: ["protoc"],
    },
    {
      name: "ruby",
      cmd: `protoc --proto_path=${path.join(repoRoot, "dist")} --ruby_out=${path.join(outRoot, "ruby")} ${protoPath}`,
      needs: ["protoc"],
    },
    {
      name: "go",
      cmd: `protoc --proto_path=${path.join(repoRoot, "dist")} --go_out=${path.join(outRoot, "go")} ${protoPath}`,
      needs: ["protoc", "protoc-gen-go"],
    },
    {
      name: "typescript",
      cmd: `npx --yes ts-proto --outputClientImpl=false --esModuleInterop=true --forceLong=string --outputEncodeMethods=true --outputJsonMethods=true --outputTypeRegistry=false --useExactTypes=false --snakeToCamel=true --env=node --proto_path=${path.join(repoRoot, "dist")} --ts_proto_out=${path.join(outRoot, "typescript")} ${protoPath}`,
      needs: ["npx"],
    },
  ];

  for (const t of targets) {
    await fs.mkdir(path.join(outRoot, t.name), { recursive: true });
    const missing = t.needs.filter((b) => !hasCmd(b));
    if (missing.length > 0) {
      notes.push(`- ${t.name}: skipped (missing ${missing.join(", ")})`);
      continue;
    }
    const res = run(t.cmd);
    notes.push(`- ${t.name}: ${res.ok ? "OK" : "FAILED"}`);
    if (!res.ok && res.output) {
      notes.push(`  - ${res.output.replace(/\n/g, "\n  - ")}`);
    }
  }

  notes.push("");
  notes.push("## Canonical source transition");
  notes.push("- Current wire protocol remains JSON over WebSocket (compat mode).");
  notes.push("- Generated proto is the typed contract for connector generation.");
  notes.push(
    "- Once connector conformance tests are complete, proto can become canonical interface spec.",
  );

  await fs.writeFile(path.join(outRoot, "README.md"), `${notes.join("\n")}\n`, "utf8");
  console.log(`wrote ${path.join(outRoot, "README.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
