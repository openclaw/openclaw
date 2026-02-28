#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit } from "../lib/audit-log.js";
import { ErrorCodes } from "../lib/error-codes.js";
import { resolvePsdPath, DEFAULT_INDEX } from "../lib/index-resolver.js";
import { expandHome } from "../lib/paths.js";
import { normalizeTask, readTask, validateTask } from "../lib/task.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--task") {
      args.task = argv[i + 1];
      i += 1;
    } else if (arg === "--index") {
      args.index = argv[i + 1];
      i += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[i + 1] || 60_000);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printResultAndExit(result, code = 0) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

function createBackup(filePath) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const backupPath = `${filePath}.bak.${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function looksLockedError(message) {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("e_file_locked") ||
    lower.includes("is locked") ||
    lower.includes("being used by another process") ||
    lower.includes("permission denied")
  );
}

function mapErrorCode(message) {
  if (looksLockedError(message)) return ErrorCodes.E_FILE_LOCKED;
  if (String(message).includes("E_LAYER_NOT_FOUND")) return ErrorCodes.E_LAYER_NOT_FOUND;
  if (String(message).includes("E_STYLE_MISMATCH")) return ErrorCodes.E_STYLE_MISMATCH;
  if (String(message).includes("E_PHOTOSHOP_UNAVAILABLE"))
    return ErrorCodes.E_PHOTOSHOP_UNAVAILABLE;
  if (String(message).includes("E_EXPORT_FAILED")) return ErrorCodes.E_EXPORT_FAILED;
  if (String(message).includes("E_FILE_AMBIGUOUS")) return ErrorCodes.E_FILE_AMBIGUOUS;
  return ErrorCodes.E_EXEC_FAILED;
}

function parseAvailableLayers(message) {
  const text = String(message || "");
  const marker = "AVAILABLE_LAYERS:";
  const idx = text.indexOf(marker);
  if (idx === -1) return [];
  const tail = text.slice(idx + marker.length);
  const raw = tail.split(/\r?\n/)[0].split(/\.\s*(?:\r?直线:|line:)/)[0] || "";
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildFuzzyLayerSuggestions(target, layers) {
  const t = String(target || "").toLowerCase();
  if (!t || layers.length === 0) return [];
  const scored = layers
    .map((layer) => {
      const l = layer.toLowerCase();
      let score = 0;
      if (l === t) score += 100;
      if (l.includes(t) || t.includes(l)) score += 50;
      if (l.startsWith(t) || t.startsWith(l)) score += 20;
      return { layer, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, 5).map((x) => x.layer);
  if (picked.length > 0) return picked;
  return layers.slice(0, 5);
}

function hasNonAscii(input) {
  return /[^\x00-\x7F]/.test(String(input || ""));
}

function prepareMacPathBridgeIfNeeded(task, workingPath) {
  const bridgeMode = task.options?.pathBridgeMode || "auto";
  if (bridgeMode === "off") {
    return { executionPath: workingPath, syncBack: () => {} };
  }
  if (bridgeMode === "always" || (bridgeMode === "auto" && hasNonAscii(workingPath))) {
    const tmpDir = path.join(os.tmpdir(), "openclaw-psd-bridge");
    fs.mkdirSync(tmpDir, { recursive: true });
    const bridgedPath = path.join(tmpDir, `${Date.now()}-${path.basename(workingPath)}`);
    fs.copyFileSync(workingPath, bridgedPath);
    return {
      executionPath: bridgedPath,
      syncBack: () => {
        fs.copyFileSync(bridgedPath, workingPath);
      },
    };
  }
  return { executionPath: workingPath, syncBack: () => {} };
}

function runMacModify(inputPath, layerName, newText, outputPath, timeoutMs) {
  const script = path.resolve(__dirname, "psd-modify-mac.applescript");
  return spawnSync("osascript", [script, inputPath, layerName, newText, outputPath], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function runWinModify(inputPath, layerName, newText, outputPath, timeoutMs) {
  const script = path.resolve(__dirname, "psd-modify-win.ps1");
  return spawnSync(
    "powershell.exe",
    ["-ExecutionPolicy", "Bypass", "-File", script, inputPath, layerName, newText, outputPath],
    { encoding: "utf8", timeout: timeoutMs },
  );
}

function runMacExportPng(inputPath, pngPath, timeoutMs) {
  const script = path.resolve(__dirname, "psd-export-png-mac.applescript");
  return spawnSync("osascript", [script, inputPath, pngPath], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function runWinExportPng(inputPath, pngPath, timeoutMs) {
  const script = path.resolve(__dirname, "psd-export-png-win.ps1");
  return spawnSync(
    "powershell.exe",
    ["-ExecutionPolicy", "Bypass", "-File", script, inputPath, pngPath],
    { encoding: "utf8", timeout: timeoutMs },
  );
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveDesktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function resolveWorkingPsdPath(task, sourcePath) {
  const sourceMode = task.workflow?.sourceMode || "inplace";
  if (sourceMode !== "copy_then_edit") {
    return { sourceMode, workingPath: sourcePath, copiedFrom: undefined };
  }
  const copyToDir = path.resolve(expandHome(task.workflow?.copyToDir || resolveDesktopDir()));
  const fileName = path.basename(sourcePath);
  const workingPath = path.join(copyToDir, fileName);
  ensureParentDir(workingPath);
  fs.copyFileSync(sourcePath, workingPath);
  return { sourceMode, workingPath, copiedFrom: sourcePath };
}

function resolveFinalPsdPath(task, workingPath) {
  const psdOutput = task.output?.psd || {};
  const mode = psdOutput.mode || "overwrite";
  if (mode === "copy" && psdOutput.path) {
    const target = path.resolve(expandHome(psdOutput.path));
    ensureParentDir(target);
    fs.copyFileSync(workingPath, target);
    return target;
  }
  return workingPath;
}

function resolvePngOutputPath(item, psdPath) {
  const dir = item.dir ? path.resolve(expandHome(item.dir)) : path.dirname(psdPath);
  const fileName = item.fileName || `${path.basename(psdPath, path.extname(psdPath))}.png`;
  return path.join(dir, fileName);
}

function executeWithRetry(params) {
  let result;
  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    result = params.execute();
    if (!result) break;
    if (result.status === 0) break;
    const message = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (!(params.retryEnabled && looksLockedError(message) && attempt < params.maxRetries)) break;
    waitMs(500 * (attempt + 1));
  }
  return result;
}

function main() {
  const start = Date.now();
  const args = parseArgs(process.argv);
  if (args.help || !args.task) {
    process.stdout.write(
      "Usage: run-task.js --task <task.json> [--index <path>] [--dry-run] [--timeout-ms <n>]\n",
    );
    process.exit(args.help ? 0 : 1);
  }

  let task;
  try {
    task = readTask(args.task);
  } catch (error) {
    printResultAndExit(
      {
        status: "error",
        code: ErrorCodes.E_TASK_INVALID,
        message: `Cannot read task: ${error.message}`,
      },
      1,
    );
  }

  const validation = validateTask(task);
  if (!validation.ok) {
    printResultAndExit(
      {
        taskId: task && task.taskId,
        status: "error",
        code: validation.code,
        message: validation.message,
      },
      1,
    );
  }

  const normalizedTask = normalizeTask(task);
  const indexPath = path.resolve(expandHome(args.index || DEFAULT_INDEX));
  const resolved = resolvePsdPath({
    exactPath: normalizedTask.input.exactPath,
    fileHint: normalizedTask.input.fileHint,
    indexPath,
  });
  if (!resolved.ok) {
    const payload = {
      taskId: normalizedTask.taskId,
      status: "error",
      code: resolved.code || ErrorCodes.E_FILE_NOT_FOUND,
      message: resolved.message,
      candidates: resolved.candidates || [],
      suggestion: resolved.suggestion,
    };
    payload.auditLogPath = appendAudit(payload);
    printResultAndExit(payload, 1);
  }

  const platform = os.platform();
  const dryRun = Boolean(args.dryRun || (normalizedTask.options && normalizedTask.options.dryRun));
  const workingInfo = resolveWorkingPsdPath(normalizedTask, resolved.path);
  const pathBridge =
    platform === "darwin"
      ? prepareMacPathBridgeIfNeeded(normalizedTask, workingInfo.workingPath)
      : { executionPath: workingInfo.workingPath, syncBack: () => {} };
  const edits = normalizedTask.input.edits || [];
  const plannedExports = Array.isArray(normalizedTask.output?.exports)
    ? normalizedTask.output.exports
    : [];
  const plannedPngPaths = plannedExports
    .filter((item) => item.format === "png")
    .map((item) => resolvePngOutputPath(item, workingInfo.workingPath));
  if (dryRun) {
    const preview = {
      taskId: normalizedTask.taskId,
      status: "dry-run",
      code: ErrorCodes.OK,
      resolvedPath: resolved.path,
      workingPath: workingInfo.workingPath,
      executionPath: pathBridge.executionPath,
      via: resolved.via,
      candidates: resolved.candidates || [],
      edits,
      plannedPngPaths,
      platform,
    };
    const auditPath = appendAudit(preview);
    preview.auditLogPath = auditPath;
    printResultAndExit(preview, 0);
  }

  let backupPath;
  try {
    if (!normalizedTask.options || normalizedTask.options.createBackup !== false) {
      backupPath = createBackup(resolved.path);
    }
  } catch (error) {
    const payload = {
      taskId: normalizedTask.taskId,
      status: "error",
      code: ErrorCodes.E_BACKUP_FAILED,
      message: error.message,
    };
    payload.auditLogPath = appendAudit(payload);
    printResultAndExit(payload, 1);
  }

  let result;
  const retryEnabled = Boolean(normalizedTask.options && normalizedTask.options.retryOnLockedFile);
  const maxRetries = Math.max(
    0,
    Math.min(5, (normalizedTask.options && normalizedTask.options.maxRetries) || 2),
  );
  const timeoutMs = args.timeoutMs || 90_000;

  if (platform === "darwin" || platform === "win32") {
    for (const edit of edits) {
      result = executeWithRetry({
        maxRetries,
        retryEnabled,
        execute: () => {
          if (platform === "darwin") {
            return runMacModify(
              pathBridge.executionPath,
              edit.layerName,
              edit.newText,
              pathBridge.executionPath,
              timeoutMs,
            );
          }
          return runWinModify(
            workingInfo.workingPath,
            edit.layerName,
            edit.newText,
            workingInfo.workingPath,
            timeoutMs,
          );
        },
      });
      if (!result || result.status !== 0) {
        break;
      }
    }
    if (platform === "darwin") {
      pathBridge.syncBack();
    }
  } else {
    printResultAndExit(
      {
        taskId: normalizedTask.taskId,
        status: "error",
        code: ErrorCodes.E_PLATFORM_UNSUPPORTED,
        message: `Unsupported platform: ${platform}`,
      },
      1,
    );
  }

  if (result?.error && result.error.code === "ETIMEDOUT") {
    printResultAndExit(
      {
        taskId: normalizedTask.taskId,
        status: "error",
        code: ErrorCodes.E_EXEC_TIMEOUT,
        message: "Photoshop execution timed out.",
      },
      1,
    );
  }

  if (!result || result.status !== 0) {
    const stderr = ((result && result.stderr) || "").trim();
    const stdout = ((result && result.stdout) || "").trim();
    const message = stderr || stdout || "Unknown execution failure.";
    const payload = {
      taskId: normalizedTask.taskId,
      status: "error",
      code: mapErrorCode(message),
      message,
      backupPath,
    };
    const availableLayers = parseAvailableLayers(message);
    if (availableLayers.length > 0) {
      payload.availableLayers = availableLayers;
      const failedEdit = edits.find((item) =>
        message.includes(`E_LAYER_NOT_FOUND: ${item.layerName}`),
      );
      const targetLayer = failedEdit ? failedEdit.layerName : "";
      payload.suggestedLayers = buildFuzzyLayerSuggestions(targetLayer, availableLayers);
      payload.suggestion =
        payload.suggestedLayers.length > 0
          ? `Try one of: ${payload.suggestedLayers.join(", ")}`
          : "Pick a layer from availableLayers.";
    }
    payload.auditLogPath = appendAudit(payload);
    printResultAndExit(payload, 1);
  }

  let finalPsdPath = workingInfo.workingPath;
  try {
    finalPsdPath = resolveFinalPsdPath(normalizedTask, workingInfo.workingPath);
  } catch (error) {
    const payload = {
      taskId: normalizedTask.taskId,
      status: "error",
      code: ErrorCodes.E_OUTPUT_WRITE_FAILED,
      message: error.message,
    };
    payload.auditLogPath = appendAudit(payload);
    printResultAndExit(payload, 1);
  }

  const pngOutputs = [];
  for (const item of plannedExports) {
    if (item.format !== "png") {
      continue;
    }
    const pngPath = resolvePngOutputPath(item, finalPsdPath);
    ensureParentDir(pngPath);
    const exportResult =
      platform === "darwin"
        ? runMacExportPng(finalPsdPath, pngPath, timeoutMs)
        : runWinExportPng(finalPsdPath, pngPath, timeoutMs);
    if (exportResult.status !== 0) {
      const payload = {
        taskId: normalizedTask.taskId,
        status: "error",
        code: ErrorCodes.E_EXPORT_FAILED,
        message: (exportResult.stderr || exportResult.stdout || "").trim() || "PNG export failed",
        psdOutputPath: finalPsdPath,
      };
      payload.auditLogPath = appendAudit(payload);
      printResultAndExit(payload, 1);
    }
    pngOutputs.push(pngPath);
  }

  const success = {
    taskId: normalizedTask.taskId,
    status: "success",
    code: ErrorCodes.OK,
    resolvedPath: resolved.path,
    psdOutputPath: finalPsdPath,
    pngOutputPath: pngOutputs[0],
    pngOutputPaths: pngOutputs,
    editsApplied: edits.map((item) => item.layerName),
    backupPath,
    via: resolved.via,
    sourceMode: workingInfo.sourceMode,
    durationMs: Date.now() - start,
    runnerStdout: (result.stdout || "").trim(),
  };
  success.auditLogPath = appendAudit(success);
  printResultAndExit(success, 0);
}

main();
