/**
 * generate-all-adapter-gates.mjs
 * 讀取 merge-map，為所有 requires_adapter 條目批量產生 gate 腳本
 * 用法: node scripts/generate-all-adapter-gates.mjs [--dry-run] [--write-state] [--force]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(currentFile), "..");
const GATE_OUT = path.join(ROOT, "scripts");
const REPORT_DIR = path.join(ROOT, "reports", "hermes-agent", "state");
const MERGE_MAP = path.join(REPORT_DIR, "openclaw-capital-angry-bohr-merge-map-latest.json");
const isDryRun = process.argv.includes("--dry-run");
const doWriteState = process.argv.includes("--write-state");

function slugify(p) {
  return p
    .replace(/\\/g, "/")
    .replace(/^scripts\/strategy-engine\//, "se-")
    .replace(/^scripts\/openclaw-capital-/, "cap-")
    .replace(/^scripts\//, "")
    .replace(/^config\//, "cfg-")
    .replace(/\.(mjs|js|json|ts)$/, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function exportFnName(slug) {
  return (
    "run" +
    slug
      .split("-")
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join("") +
    "Gate"
  );
}

function normalizeRelPath(input) {
  if (typeof input !== "string") {
    return { ok: false, reason: "no_path" };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, reason: "no_path" };
  }
  if (raw.includes("\0")) {
    return { ok: false, reason: "invalid_nul_char" };
  }

  const unified = raw.replace(/\\/g, "/");
  if (path.posix.isAbsolute(unified) || /^[A-Za-z]:\//.test(unified)) {
    return { ok: false, reason: "invalid_absolute_path" };
  }

  let normalized = path.posix.normalize(unified);
  normalized = normalized.replace(/^\.\/+/, "");
  normalized = normalized.replace(/\/+$/, "");
  if (!normalized || normalized === ".") {
    return { ok: false, reason: "invalid_empty_path" };
  }
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return { ok: false, reason: "invalid_path_traversal" };
  }

  // 過濾非腳本檔案 (.bat, nul 裝置, 純目錄)
  if (/\.bat$/i.test(normalized)) {
    return { ok: false, reason: "bat_file_excluded" };
  }
  if (/^nul\b/i.test(normalized)) {
    return { ok: false, reason: "nul_device_excluded" };
  }
  if (normalized.endsWith("/")) {
    return { ok: false, reason: "directory_excluded" };
  }
  // 過濾非 ASCII 路徑 (CJK 編碼)
  if ([...normalized].some((char) => char.charCodeAt(0) > 0x7f)) {
    return { ok: false, reason: "non_ascii_path" };
  }

  const root = normalized.split("/")[0];
  const allowedRoots = new Set(["scripts", "config"]);
  if (!allowedRoots.has(root)) {
    return { ok: false, reason: "invalid_root_scope" };
  }

  return { ok: true, path: normalized };
}

// 使用字串陣列拼接，完全避免巢狀模板字面量轉義問題
function buildGateCode(relPath, slug) {
  const srcPosix = relPath.replace(/\\/g, "/");
  const srcParts = srcPosix.split("/").filter(Boolean);
  const srcPartsJs = srcParts.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",");
  const schema = "openclaw.capital.adapter-gate." + slug + ".v1";
  const fn = exportFnName(slug);
  const rptName = "openclaw-capital-" + slug + "-gate-latest.json";
  const srcEsc = srcPosix;
  const lines = [
    "/**",
    " * openclaw-capital-" + slug + "-gate.mjs — adapter gate（自動生成）",
    " * 來源: " + srcEsc,
    " */",
    'import crypto from "node:crypto";',
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const currentFile = fileURLToPath(import.meta.url);",
    'const repoRoot = path.resolve(path.dirname(currentFile), "..");',
    'const SCHEMA = "' + schema + '";',
    "const SOURCE_REL_PARTS = [" + srcPartsJs + "];",
    "const DEFAULT_SOURCE_CANDIDATES = [",
    '  path.join(repoRoot, ".claude", "worktrees", "angry-bohr-619b69", ...SOURCE_REL_PARTS),',
    "  path.join(repoRoot, ...SOURCE_REL_PARTS),",
    "];",
    'const DEFAULT_REPORT = path.join(repoRoot, "reports", "hermes-agent", "state", "' +
      rptName +
      '");',
    "function hasFlag(f){return process.argv.includes(f)}",
    'function argVal(n,d=""){const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:d}',
    'function sha256(t){return crypto.createHash("sha256").update(t).digest("hex").toUpperCase()}',
    'async function readOpt(p){try{const r=(await fs.readFile(p,"utf8")).replace(/^\\uFEFF/u,"");return{exists:true,text:r,sha256:sha256(r),sizeBytes:Buffer.byteLength(r),error:""}}catch(e){return{exists:false,text:"",sha256:"",sizeBytes:0,error:e.message}}}',
    "const DANGER=[",
    '  {id:"file_write",re:/\\b(writeFileSync|appendFileSync|createWriteStream)\\b/g,sev:"high",zh:"寫入檔案"},',
    '  {id:"timer",re:/\\b(setInterval|setTimeout)\\b/g,sev:"medium",zh:"計時器"},',
    '  {id:"child_process",re:/\\b(execSync|spawn|exec)\\b/g,sev:"high",zh:"子程序"},',
    '  {id:"network",re:/\\b(fetch|http\\.request|WebSocket)\\b/g,sev:"high",zh:"網路"},',
    '  {id:"external_path",re:/D:\\\\\\\\[^"\\x27\\s]+|D:\\/[^"\\x27\\s]+/g,sev:"medium",zh:"外部路徑"},',
    '  {id:"com_object",re:/\\b(CreateObject|SKCOM|SKOrder|SKQuote)\\b/gi,sev:"critical",zh:"COM"},',
    '  {id:"live_order",re:/\\b(SendFutureOrder|placeOrder|routeSignal)\\b/g,sev:"critical",zh:"實單"},',
    '  {id:"credential",re:/\\b(password|credential|apiKey|secret|passphrase)\\b/gi,sev:"high",zh:"憑證"},',
    "];",
    "function scanSrc(src){",
    "  const checks=[];",
    "  const blockers=[];",
    "  for(const d of DANGER){",
    "    const m=src.match(d.re)||[];",
    "    checks.push({id:d.id,label:d.zh,severity:d.sev,found:m.length>0,count:m.length});",
    '    if(m.length>0&&(d.sev==="critical"||d.sev==="high")){',
    "      blockers.push({id:d.id,label:d.zh,severity:d.sev,count:m.length});",
    "    }",
    "  }",
    "  return{checks,blockers};",
    "}",
    "export async function " + fn + "(options={}){",
    "  const sourceCandidates=options.sourcePath?[path.resolve(options.sourcePath)]:DEFAULT_SOURCE_CANDIDATES.map(p=>path.resolve(p));",
    "  let sourcePath=sourceCandidates[0];",
    '  let source={exists:false,text:"",sha256:"",sizeBytes:0,error:""};',
    "  for(const c of sourceCandidates){const r=await readOpt(c);sourcePath=c;source=r;if(r.exists){break}}",
    "  const reportPath=path.resolve(options.reportPath||DEFAULT_REPORT);",
    "  const now=options.now instanceof Date?options.now:new Date();",
    '  const{checks,blockers}=source.exists?scanSrc(source.text):{checks:[],blockers:[{id:"source_missing",label:"原始碼不存在",severity:"critical",count:1}]};',
    '  const report={schema:SCHEMA,generatedAt:now.toISOString(),status:blockers.length>0?"blocked":"gated_ready",blockerCode:blockers.length>0?blockers.map(b=>b.id).join("+"):"none",mode:"read_only_gate",source:{path:sourcePath,exists:source.exists,sha256:source.sha256,sizeBytes:source.sizeBytes,error:source.error},safety:{allowLiveTrading:false,writeBrokerOrders:false,externalWriteEnabled:false,sentOrder:false,loginAttempted:false,readOnlyReportOnly:true},checks,blockers,nextSafeTask:blockers.length>0?"修復 "+blockers[0].label+" 於 "+SOURCE_REL_PARTS.join("/"):"靜態分析通過，可進入整合測試"};',
    '  if(options.writeState===true){await fs.mkdir(path.dirname(reportPath),{recursive:true});const j=JSON.stringify(report,null,2)+"\\n";await fs.writeFile(reportPath,j);await fs.writeFile(reportPath+".sha256",sha256(j)+"\\n","ascii")}',
    "  return{report,reportPath};",
    "}",
    "if(process.argv[1]&&path.resolve(process.argv[1])===currentFile){",
    "  const{report}=await " +
      fn +
      '({sourcePath:argVal("--source"),reportPath:argVal("--report"),writeState:hasFlag("--write-state")});',
    '  if(hasFlag("--json")){console.log(JSON.stringify(report,null,2))}',
    '  else{console.log("["+report.status+"] "+SCHEMA+"\\n  來源: "+report.source.path+" ("+report.source.sizeBytes+"B)\\n  阻擋: "+report.blockers.length+" — "+report.blockerCode+"\\n  下一步: "+report.nextSafeTask)}',
    "}",
  ];
  return lines.join("\n") + "\n";
}

// === Main ===
async function main() {
  let mapData;
  try {
    mapData = JSON.parse(readFileSync(MERGE_MAP, "utf-8"));
  } catch (e) {
    console.error("無法讀取 merge-map:", e.message);
    process.exit(1);
  }

  // 提取 requires_adapter 條目 — 從 categories.requires_adapter 取得
  let adapters = [];
  const cats = mapData.categories || {};
  if (Array.isArray(cats.requires_adapter)) {
    adapters = cats.requires_adapter;
  }
  // 合併 dirty.items 中的 requires_adapter（若有）
  const dirtyItems = (mapData.dirty || {}).items || [];
  if (Array.isArray(dirtyItems)) {
    const dirtyAdapters = dirtyItems.filter(
      (e) => (e.category || e.mergeCategory) === "requires_adapter",
    );
    const existing = new Set(adapters.map((a) => a.path || a.file));
    for (const da of dirtyAdapters) {
      if (!existing.has(da.path || da.file)) {
        adapters.push(da);
      }
    }
  }

  console.log("\n=== Adapter Gate 批量生成器 ===");
  console.log("requires_adapter: " + adapters.length + " 條目");
  console.log("模式: " + (isDryRun ? "DRY-RUN" : "WRITE") + "\n");

  const generated = [],
    skipped = [],
    invalid = [];
  for (const entry of adapters) {
    const rawPath = entry.path || entry.file || entry.relativePath;
    const norm = normalizeRelPath(rawPath);
    if (!norm.ok) {
      const item = { path: rawPath || "", reason: norm.reason };
      skipped.push(item);
      invalid.push(item);
      console.log("  [SKIP:" + norm.reason + "] " + (rawPath || "<empty>"));
      continue;
    }

    const relPath = norm.path;
    const slug = slugify(relPath);
    if (!slug) {
      const item = { path: relPath, reason: "invalid_slug" };
      skipped.push(item);
      invalid.push(item);
      console.log("  [SKIP:invalid_slug] " + relPath);
      continue;
    }

    const gateFile = path.join(GATE_OUT, "openclaw-capital-" + slug + "-gate.mjs");
    const checkFile = path.join(GATE_OUT, "check-capital-" + slug + "-gate.mjs");

    if (existsSync(gateFile) && !process.argv.includes("--force")) {
      skipped.push({ path: relPath, reason: "exists" });
      continue;
    }

    const code = buildGateCode(relPath, slug);
    if (!isDryRun) {
      writeFileSync(gateFile, code, "utf-8");
      const checkCode =
        "import{" +
        exportFnName(slug) +
        ' as run}from"./openclaw-capital-' +
        slug +
        '-gate.mjs";const{report}=await run({writeState:true});console.log("[✓] "+report.schema+" → "+report.status+" (blockers="+report.blockers.length+")");\n';
      writeFileSync(checkFile, checkCode, "utf-8");
    }
    generated.push({ path: relPath, slug, gate: "openclaw-capital-" + slug + "-gate.mjs" });
    console.log("  " + (isDryRun ? "[DRY]" : "[OK]") + " " + slug + " ← " + relPath);
  }

  // 彙總報告
  if (!isDryRun) {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(REPORT_DIR, "adapter-gates-generation-summary.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          total: adapters.length,
          generated: generated.length,
          skipped: skipped.length,
          invalid: invalid.length,
          invalidPaths: invalid.slice(0, 100),
          gates: generated,
        },
        null,
        2,
      ) + "\n",
    );
  }

  console.log("\n=== 結果 ===");
  console.log("生成: " + generated.length + " gate + " + generated.length + " check");
  console.log("跳過: " + skipped.length);
  console.log("非法路徑: " + invalid.length);

  // 執行全部 gate 初始報告
  if (doWriteState && !isDryRun) {
    console.log("\n執行全部 gate 寫入報告...");
    for (const g of generated) {
      try {
        const mod = await import(pathToFileURL(path.join(GATE_OUT, g.gate)).href);
        const fnKey = Object.keys(mod).find((k) => k.startsWith("run") && k.endsWith("Gate"));
        if (fnKey) {
          const { report } = await mod[fnKey]({ writeState: true });
          console.log(
            "  [" + report.status + "] " + g.slug + " (" + report.blockers.length + " blockers)",
          );
        }
      } catch (e) {
        console.log("  [ERR] " + g.slug + ": " + e.message.slice(0, 80));
      }
    }
    console.log("\n✅ 初始報告已寫入");
  }

  if (!isDryRun && generated.length > 0) {
    console.log("\n✅ 全部 adapter gate 已生成");
    console.log("下一步: node scripts/generate-all-adapter-gates.mjs --write-state");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
