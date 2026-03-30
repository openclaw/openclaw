import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "1.0.0";

const state = {
  connected: false,
  host: null,
  port: 7000,
};

const ALLOWED_METHODS = new Set([
  "ScanControllers",
  "Connect",
  "Disconnect",
  "GetStatus",
  "GetSystemInfo",
  "GetServiceInfo",
  "GetSpeedRatio",
  "SetSpeedRatio",
  "GetJointPositions",
  "GetWorldPosition",
  "GetEventLogEntries",
  "ListTasks",
  "BackupModule",
  "ResetProgramPointer",
  "MoveToJoints",
  "ExecuteRapidProgram",
  "LoadRapidProgram",
  "StartRapid",
  "StopRapid",
  "SetMotors",
]);

function parseBridgeJsonOutput(rawOut) {
  const tryParse = (text) => {
    const t = String(text || "").trim();
    if (!t) return null;

    try {
      return JSON.parse(t);
    } catch {
      // Some shells may surface escaped JSON fragments, e.g. {\"success\":true}
      if (t.includes('\\"') || t.includes("\\n") || t.includes("\\r")) {
        const unescaped = t
          .replace(/\\"/g, '"')
          .replace(/\\r\\n/g, "\n")
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r");
        try {
          return JSON.parse(unescaped);
        } catch {
          return null;
        }
      }
      return null;
    }
  };

  const out = String(rawOut || "").trim();
  if (!out) return null;

  const direct = tryParse(out);
  if (direct) return direct;

  // Some ABB SDK calls may emit diagnostic lines before the final JSON object.
  for (let i = out.lastIndexOf("{"); i >= 0; i = out.lastIndexOf("{", i - 1)) {
    const candidate = out.slice(i).trim();
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function result(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function buildLogDiagnosis(logEntries, status, tasks, errorHint) {
  const lines = (logEntries || []).map((e) =>
    `${e.number || ""} ${e.title || ""} ${e.type || ""}`.trim(),
  );
  const joined = `${lines.join("\n")}\n${String(errorHint || "")}`.toLowerCase();
  const issues = [];
  const recommendations = [];

  if (
    joined.includes("semantic") ||
    joined.includes("openclawmotionmod") ||
    joined.includes("resetpp") ||
    joined.includes("行") ||
    joined.includes("错误")
  ) {
    issues.push(
      "RAPID semantic error detected (likely module/task syntax or pointer target mismatch).",
    );
    recommendations.push(
      "Run: abb_robot_real action:list_tasks and pick task/module that actually exists before reset or backup.",
    );
    recommendations.push(
      "If OpenClawMotionMod has syntax errors, fix RAPID source and use load_rapid before start_program.",
    );
    recommendations.push(
      "Avoid blind reset on T_ROB1 when semantic errors exist; inspect event log details first.",
    );
  }

  if (
    joined.includes("mastership") ||
    joined.includes("nomaster") ||
    joined.includes("demandgrant")
  ) {
    issues.push("Mastership/authorization related issue detected.");
    recommendations.push(
      "Retry command after ensuring controller is in Auto and user has ExecuteRapid grant.",
    );
  }

  const mode = String(status?.operationMode || "");
  const motors = String(status?.motorState || "");
  if (mode && mode.toLowerCase() !== "auto") {
    issues.push(`Controller mode is ${mode}, not Auto.`);
    recommendations.push("Switch controller to Auto before RAPID/motion operations.");
  }
  if (motors && motors.toLowerCase() !== "motorson") {
    issues.push(`Controller motors state is ${motors}.`);
    recommendations.push("Enable motors before motion operations.");
  }

  if (Array.isArray(tasks) && tasks.length > 0) {
    const first = tasks[0];
    if (Array.isArray(first.modules) && first.modules.length > 0) {
      recommendations.push(
        `Preferred task/module candidate: ${first.taskName} / ${first.modules[0]}`,
      );
    }
  }

  if (issues.length === 0) {
    issues.push("No critical error signatures found in latest logs.");
    recommendations.push("Proceed with low-speed movj and monitor get_event_log for new errors.");
  }

  return { issues, recommendations };
}

function psQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maxJointDiff(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Number.POSITIVE_INFINITY;
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs((Number(a[i]) || 0) - (Number(b[i]) || 0));
    if (d > m) m = d;
  }
  return m;
}

async function fetchStatusAndLogs(host, port, bridgeDllPath, logLimit = 8) {
  const [status, log] = await Promise.all([
    invokeBridge("GetStatus", {}, host, port, bridgeDllPath),
    invokeBridge(
      "GetEventLogEntries",
      { limit: logLimit, categoryId: 0 },
      host,
      port,
      bridgeDllPath,
    ),
  ]);

  const categoryLogs = [];
  for (const categoryId of [0, 1, 2, 3, 4, 5, 6]) {
    const entry = await invokeBridge(
      "GetEventLogEntries",
      { limit: Math.min(logLimit, 5), categoryId },
      host,
      port,
      bridgeDllPath,
    );
    if (entry?.success) {
      categoryLogs.push({
        categoryId,
        categoryName: entry.categoryName,
        entries: entry.entries || [],
      });
    }
  }

  return { status, log, categoryLogs };
}

async function waitMotionSettled({
  host,
  port,
  bridgeDllPath,
  targetJoints,
  baselineJoints,
  timeoutMs,
  pollMs,
  toleranceDeg,
  motionDetectDeg,
}) {
  const startedAt = Date.now();
  let observedMovement = false;
  let lastJoints = baselineJoints;
  let finalJoints = baselineJoints;
  let finalStatus = null;

  while (Date.now() - startedAt < timeoutMs) {
    const [jRes, sRes] = await Promise.all([
      invokeBridge("GetJointPositions", {}, host, port, bridgeDllPath),
      invokeBridge("GetStatus", {}, host, port, bridgeDllPath),
    ]);

    if (jRes.success && Array.isArray(jRes.joints)) {
      finalJoints = jRes.joints;
      const movedFromBaseline = maxJointDiff(baselineJoints, finalJoints);
      const movedFromLast = maxJointDiff(lastJoints, finalJoints);
      if (movedFromBaseline >= motionDetectDeg || movedFromLast >= motionDetectDeg) {
        observedMovement = true;
      }
      lastJoints = finalJoints;

      const targetErr = maxJointDiff(targetJoints, finalJoints);
      const rapidRunning = !!sRes?.rapidRunning;
      if (targetErr <= toleranceDeg && !rapidRunning) {
        finalStatus = sRes;
        const { status, log } = await fetchStatusAndLogs(host, port, bridgeDllPath);
        return {
          success: true,
          observedMovement,
          settled: true,
          durationMs: Date.now() - startedAt,
          targetErrorDeg: targetErr,
          finalJoints,
          status,
          log,
        };
      }
    }

    if (sRes?.success) {
      finalStatus = sRes;
    }

    await sleep(pollMs);
  }

  const targetErr = maxJointDiff(targetJoints, finalJoints);
  const { status, log } = await fetchStatusAndLogs(host, port, bridgeDllPath);
  return {
    success: false,
    observedMovement,
    settled: false,
    durationMs: Date.now() - startedAt,
    targetErrorDeg: targetErr,
    finalJoints,
    status,
    log,
  };
}

async function waitRapidIdle(host, port, bridgeDllPath, timeoutMs = 60000, pollMs = 500) {
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    const status = await invokeBridge("GetStatus", {}, host, port, bridgeDllPath);
    if (status.success) {
      lastStatus = status;
      if (!status.rapidRunning) {
        const { log } = await fetchStatusAndLogs(host, port, bridgeDllPath);
        return { success: true, durationMs: Date.now() - startedAt, status, log };
      }
    }
    await sleep(pollMs);
  }
  const { status, log } = await fetchStatusAndLogs(host, port, bridgeDllPath);
  return {
    success: false,
    durationMs: Date.now() - startedAt,
    status: status.success ? status : lastStatus,
    log,
  };
}

function runPowerShell(script, timeoutMs = 15000) {
  const psExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  return new Promise((resolve, reject) => {
    const child = spawn(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {}
        reject(new Error(`PowerShell bridge timeout after ${timeoutMs}ms`));
      },
      Math.max(1000, Number(timeoutMs) || 15000),
    );

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || "PowerShell command failed").trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function invokeBridge(method, payload, host, port, dllPathOverride) {
  if (!ALLOWED_METHODS.has(method)) {
    return { success: false, error: `Unsupported bridge method: ${method}` };
  }

  const payloadJson = JSON.stringify(payload || {});
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64");
  const defaultDllPath = path.resolve(__dirname, "../abb-robot-control/src/ABBBridge.dll");
  const dllPath = String(dllPathOverride || defaultDllPath);

  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dllPath = '${psQuoted(dllPath)}'
if (-not (Test-Path $dllPath)) { throw "ABBBridge.dll not found: $dllPath" }
Add-Type -Path $dllPath
$bridge = New-Object ABBBridge
$connectPayload = @{ host='${psQuoted(host)}'; port=${Number(port) || 7000} }
if ('${method}' -ne 'ScanControllers') {
  $connectResult = $bridge.Connect($connectPayload).GetAwaiter().GetResult()
  if (-not $connectResult.success) {
    $connectResult | ConvertTo-Json -Depth 20 -Compress
    exit 0
  }
}
$payloadJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadB64}'))
$payload = if ([string]::IsNullOrWhiteSpace($payloadJson)) {
  @{}
} else {
  $tmp = ConvertFrom-Json -InputObject $payloadJson
  if ($tmp -is [System.Collections.IDictionary]) {
    $tmp
  } elseif ($tmp -is [psobject]) {
    $h = @{}
    foreach ($p in $tmp.PSObject.Properties) {
      $h[$p.Name] = $p.Value
    }
    $h
  } else {
    @{}
  }
}
$result = $bridge.${method}($payload).GetAwaiter().GetResult()
try { $bridge.Disconnect(@{}).GetAwaiter().GetResult() | Out-Null } catch {}
$result | ConvertTo-Json -Depth 20 -Compress
`;

  const out = await runPowerShell(script, 15000);
  if (!out) return { success: false, error: "No output from bridge" };

  const parsed = parseBridgeJsonOutput(out);
  if (parsed) return parsed;
  return { success: false, error: `Unexpected bridge output: ${out}` };
}

async function handleAction(action, params, config) {
  const host = String(params.host || state.host || config?.controllerHost || "127.0.0.1");
  const port = Number(params.port || state.port || config?.controllerPort || 7000);
  const bridgeDllPath = config?.bridgeDllPath;

  switch (action) {
    case "get_version":
      return result(`abb_robot_real version: ${VERSION}`, { success: true, version: VERSION });

    case "scan_controllers": {
      const scan = await invokeBridge("ScanControllers", {}, host, port, bridgeDllPath);
      if (!scan.success)
        return result(`Scan failed: ${scan.error || "unknown"}`, { success: false, result: scan });
      return result(`Scanned controllers: ${scan.total}`, { success: true, result: scan });
    }

    case "connect": {
      const allowVirtualController =
        params.allowVirtualController === true ||
        String(params.allowVirtualController || "")
          .trim()
          .toLowerCase() === "true";
      const conn = await invokeBridge("GetStatus", {}, host, port, bridgeDllPath);
      if (!conn.success) {
        state.connected = false;
        return result(`Real connect failed: ${conn.error || "unknown"}`, {
          success: false,
          result: conn,
        });
      }

      // Guardrail: real plugin should not silently attach to virtual controllers.
      const scan = await invokeBridge("ScanControllers", {}, host, port, bridgeDllPath);
      const localHostRequested = ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
      const matchedController = scan?.success
        ? (scan.controllers || []).find((c) => {
            const ip = String(c?.ip || "").toLowerCase();
            const id = String(c?.id || "").toLowerCase();
            const sys = String(c?.systemId || "").toLowerCase();
            const name = String(c?.systemName || "").toLowerCase();
            const target = host.toLowerCase();
            return (
              ip === target ||
              id === target ||
              sys === target ||
              name === target ||
              (localHostRequested && c?.isVirtual)
            );
          })
        : null;

      if (!allowVirtualController && matchedController?.isVirtual) {
        state.connected = false;
        return result(
          `Real connect rejected: target '${host}' resolves to a virtual controller (${matchedController.systemName || "unknown"}). ` +
            `Use real controller IP/ID, or set allowVirtualController=true only for debugging.`,
          {
            success: false,
            virtualControllerDetected: true,
            host,
            port,
            matchedController,
            scan,
          },
        );
      }

      state.connected = true;
      state.host = host;
      state.port = port;
      return result(`Real connected (${host}:${port})`, {
        success: true,
        connected: true,
        host,
        port,
        status: conn,
        controller: matchedController || null,
      });
    }

    case "disconnect":
      state.connected = false;
      return result("Real disconnected.", { success: true, connected: false });
  }

  if (!state.connected || !state.host) {
    return result("Real mode not connected. Run connect first.", { success: false });
  }

  switch (action) {
    case "get_status": {
      const r = await invokeBridge("GetStatus", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success ? "Real status fetched." : `Real status failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "get_system_info": {
      const r = await invokeBridge("GetSystemInfo", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success ? "System info fetched." : `System info failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "get_service_info": {
      const r = await invokeBridge("GetServiceInfo", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success ? "Service info fetched." : `Service info failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "get_speed": {
      const r = await invokeBridge("GetSpeedRatio", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success ? `Speed ratio: ${r.speedRatio}` : `Get speed failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "set_speed": {
      const speed = Number(params.speed || 100);
      const r = await invokeBridge(
        "SetSpeedRatio",
        { speed },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(
        r.success
          ? `Speed ratio set: ${r.speedRatio}`
          : `Set speed failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "get_joints": {
      const r = await invokeBridge("GetJointPositions", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success
          ? `Joints: [${(r.joints || []).join(", ")}]`
          : `Get joints failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "get_world_position": {
      const r = await invokeBridge("GetWorldPosition", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success ? "World position fetched." : `World position failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "get_event_log": {
      const limit = Number(params.limit || 20);
      const categoryId = Number(params.categoryId || 0);
      const r = await invokeBridge(
        "GetEventLogEntries",
        { limit, categoryId },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(
        r.success ? `Event log entries: ${r.count}` : `Event log failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "query_logs": {
      const limit = Number(params.limit || 20);
      const categoryId = Number(params.categoryId || 0);
      const r = await invokeBridge(
        "GetEventLogEntries",
        { limit, categoryId },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(
        r.success ? `Event log entries: ${r.count}` : `Event log failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "analyze_logs": {
      const limit = Number(params.limit || 20);
      const categoryId = Number(params.categoryId || 0);
      const log = await invokeBridge(
        "GetEventLogEntries",
        { limit, categoryId },
        state.host,
        state.port,
        bridgeDllPath,
      );
      const status = await invokeBridge("GetStatus", {}, state.host, state.port, bridgeDllPath);
      const tasks = await invokeBridge("ListTasks", {}, state.host, state.port, bridgeDllPath);

      if (!log.success) {
        return result(`Analyze logs failed: ${log.error || "unknown"}`, {
          success: false,
          log,
          status,
          tasks,
        });
      }

      const diagnosis = buildLogDiagnosis(
        log.entries || [],
        status,
        tasks.tasks || [],
        params.error_hint,
      );
      const text = [
        `Log analysis complete (${log.count} entries).`,
        `Issues:`,
        ...diagnosis.issues.map((x) => `- ${x}`),
        `Recommended next actions:`,
        ...diagnosis.recommendations.map((x) => `- ${x}`),
      ].join("\n");

      return result(text, {
        success: true,
        diagnosis,
        log,
        status,
        tasks,
      });
    }
    case "list_tasks": {
      const r = await invokeBridge("ListTasks", {}, state.host, state.port, bridgeDllPath);
      return result(
        r.success ? `Tasks discovered: ${r.count}` : `List tasks failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "backup_module": {
      const moduleName = String(params.moduleName || "");
      const taskName = String(params.taskName || "");
      const outputDir = String(params.outputDir || process.cwd());
      const r = await invokeBridge(
        "BackupModule",
        { moduleName, taskName, outputDir },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(
        r.success ? `Module backup done: ${moduleName}` : `Backup failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "reset_program_pointer": {
      const taskName = String(params.taskName || "T_ROB1");
      const r = await invokeBridge(
        "ResetProgramPointer",
        { taskName },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(
        r.success
          ? `Program pointer reset: ${taskName}`
          : `Reset pointer failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "set_joints":
    case "movj": {
      const joints = Array.isArray(params.joints)
        ? params.joints.map((x) => Number(x) || 0).slice(0, 6)
        : null;
      if (!joints || joints.length !== 6)
        return result("movj/set_joints requires exactly 6 joint values.", { success: false });
      const speed = Number(params.speed || 20);
      const zone = String(params.zone || "fine");
      const timeoutMs = Math.max(3000, Math.min(120000, Number(params.motionTimeoutMs || 30000)));
      const pollMs = Math.max(100, Math.min(2000, Number(params.pollIntervalMs || 400)));
      const toleranceDeg = Math.max(0.05, Math.min(5, Number(params.toleranceDeg || 0.4)));
      const motionDetectDeg = Math.max(0.05, Math.min(5, Number(params.motionDetectDeg || 0.2)));

      const before = await invokeBridge(
        "GetJointPositions",
        {},
        state.host,
        state.port,
        bridgeDllPath,
      );
      const baselineJoints = Array.isArray(before?.joints) ? before.joints : null;

      const r = await invokeBridge(
        "MoveToJoints",
        { joints, speed, zone },
        state.host,
        state.port,
        bridgeDllPath,
      );
      if (!r.success) {
        const diag = await fetchStatusAndLogs(state.host, state.port, bridgeDllPath);
        return result(`Move failed: ${r.error || "unknown"}`, {
          success: false,
          result: r,
          before,
          ...diag,
        });
      }

      const verify = await waitMotionSettled({
        host: state.host,
        port: state.port,
        bridgeDllPath,
        targetJoints: joints,
        baselineJoints: baselineJoints || joints,
        timeoutMs,
        pollMs,
        toleranceDeg,
        motionDetectDeg,
      });

      if (!verify.success) {
        const noMotion =
          !verify.observedMovement &&
          maxJointDiff(joints, baselineJoints || joints) > motionDetectDeg;
        const reason = noMotion
          ? "No robot motion observed after command dispatch"
          : `Motion did not settle within timeout (${timeoutMs}ms)`;
        return result(`Move dispatched but verification failed: ${reason}`, {
          success: false,
          verificationFailed: true,
          reason,
          before,
          commandResult: r,
          verification: verify,
        });
      }

      return result("Move executed and verified complete.", {
        success: true,
        before,
        commandResult: r,
        verification: verify,
      });
    }
    case "movj_rapid": {
      // 方案B: load_rapid → start_program → wait (默认推荐方案)
      const joints = Array.isArray(params.joints)
        ? params.joints.map((x) => Number(x) || 0).slice(0, 6)
        : null;
      if (!joints || joints.length !== 6)
        return result("movj_rapid requires exactly 6 joint values.", { success: false });
      const speed = Math.max(1, Math.min(100, Number(params.speed || 20)));
      const zone = String(params.zone || "fine");
      const taskName = String(params.taskName || "T_ROB1");
      const moduleName = String(params.moduleName || "OpenClawMove");
      const waitMs = Math.max(3000, Math.min(300000, Number(params.programTimeoutMs || 60000)));

      // 生成标准RAPID程序
      const j = joints;
      const speedVal = Math.max(1, Math.min(7000, speed * 10));
      const rapidCode = [
        `MODULE ${moduleName}`,
        `  PROC main()`,
        `    MoveAbsJ [[${j[0]},${j[1]},${j[2]},${j[3]},${j[4]},${j[5]}],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]], [${speedVal},500,5000,1000], ${zone}, tool0;`,
        `  ENDPROC`,
        `ENDMODULE`,
      ].join("\n");

      // 读取运动前关节角
      const before = await invokeBridge(
        "GetJointPositions",
        {},
        state.host,
        state.port,
        bridgeDllPath,
      );

      // 加载程序
      const loadR = await invokeBridge(
        "LoadRapidProgram",
        { code: rapidCode, moduleName, taskName },
        state.host,
        state.port,
        bridgeDllPath,
      );
      if (!loadR.success) {
        return result(`movj_rapid load failed: ${loadR.error || "unknown"}`, {
          success: false,
          result: loadR,
          rapidCode,
        });
      }

      // 复位程序指针
      await invokeBridge(
        "ResetProgramPointer",
        { taskName },
        state.host,
        state.port,
        bridgeDllPath,
      );

      // 启动程序
      const startR = await invokeBridge(
        "StartRapid",
        { allowRealExecution: true },
        state.host,
        state.port,
        bridgeDllPath,
      );
      if (!startR.success) {
        const diag = await fetchStatusAndLogs(state.host, state.port, bridgeDllPath);
        return result(`movj_rapid start failed: ${startR.error || "unknown"}`, {
          success: false,
          result: startR,
          rapidCode,
          ...diag,
        });
      }

      // 等待程序执行完成
      const idle = await waitRapidIdle(state.host, state.port, bridgeDllPath, waitMs, 400);
      const after = await invokeBridge(
        "GetJointPositions",
        {},
        state.host,
        state.port,
        bridgeDllPath,
      );

      if (!idle.success) {
        return result(`movj_rapid: program did not finish within timeout (${waitMs}ms).`, {
          success: false,
          before,
          after,
          startResult: startR,
          waitResult: idle,
          rapidCode,
        });
      }

      return result("movj_rapid executed and completed.", {
        success: true,
        before,
        after,
        finalJoints: Array.isArray(after?.joints) ? after.joints : null,
        rapidCode,
        loadResult: loadR,
        startResult: startR,
        waitResult: idle,
      });
    }

    case "execute_rapid": {
      const code = String(params.code || params.rapid_code || "");
      const moduleName = String(params.moduleName || params.module_name || "OpenClawMotionMod");
      const allowRealExecution = params.allowRealExecution === true;
      if (!code) return result("execute_rapid requires code.", { success: false });
      const r = await invokeBridge(
        "ExecuteRapidProgram",
        { code, moduleName, allowRealExecution },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(r.success ? "RAPID executed." : `RAPID failed: ${r.error || "unknown"}`, {
        success: !!r.success,
        result: r,
      });
    }
    case "load_rapid": {
      const code = String(params.code || params.rapid_code || "");
      const moduleName = String(params.moduleName || params.module_name || "OpenClawMotionMod");
      if (!code) return result("load_rapid requires code.", { success: false });
      const r = await invokeBridge(
        "LoadRapidProgram",
        { code, moduleName },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(r.success ? "RAPID loaded." : `Load RAPID failed: ${r.error || "unknown"}`, {
        success: !!r.success,
        result: r,
      });
    }
    case "start_program": {
      const allowRealExecution = params.allowRealExecution === true;
      const r = await invokeBridge(
        "StartRapid",
        { allowRealExecution },
        state.host,
        state.port,
        bridgeDllPath,
      );
      if (!r.success) {
        const diag = await fetchStatusAndLogs(state.host, state.port, bridgeDllPath);
        return result(`Start failed: ${r.error || "unknown"}`, {
          success: false,
          result: r,
          ...diag,
        });
      }

      const waitForCompletion = params.waitForCompletion !== false;
      if (!waitForCompletion) {
        return result("Program started (not waiting for completion).", {
          success: true,
          result: r,
        });
      }

      const waitMs = Math.max(3000, Math.min(300000, Number(params.programTimeoutMs || 60000)));
      const idle = await waitRapidIdle(state.host, state.port, bridgeDllPath, waitMs, 500);
      if (!idle.success) {
        return result(`Program started but did not finish within timeout (${waitMs}ms).`, {
          success: false,
          result: r,
          waitResult: idle,
        });
      }
      return result("Program execution completed.", {
        success: true,
        result: r,
        waitResult: idle,
      });
    }
    case "stop_program": {
      const r = await invokeBridge("StopRapid", {}, state.host, state.port, bridgeDllPath);
      return result(r.success ? "Program stopped." : `Stop failed: ${r.error || "unknown"}`, {
        success: !!r.success,
        result: r,
      });
    }
    case "motors_on":
    case "motors_off": {
      const motorState = action === "motors_on" ? "ON" : "OFF";
      const r = await invokeBridge(
        "SetMotors",
        { state: motorState },
        state.host,
        state.port,
        bridgeDllPath,
      );
      return result(
        r.success ? `Motors ${motorState}` : `Set motors failed: ${r.error || "unknown"}`,
        { success: !!r.success, result: r },
      );
    }
    case "list_robots":
      return result("Real plugin supports controller scanning via scan_controllers.", {
        success: true,
      });
    default:
      return result(`Unsupported real action: ${action}`, { success: false });
  }
}

const plugin = {
  id: "abb-robot-real-control",
  name: "ABB Robot Real Control",
  description: "Independent real ABB robot control plugin via ABBBridge.dll",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      controllerHost: { type: "string" },
      controllerPort: { type: "number", minimum: 1, maximum: 65535 },
      bridgeDllPath: { type: "string" },
    },
  },
  register(api, config) {
    api.registerTool({
      name: "abb_robot_real",
      description: "Real ABB controller tool (scan/connect/control/backup/logs).",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          action: { type: "string" },
          host: { type: "string" },
          port: { type: "number" },
          allowVirtualController: { type: "boolean" },
          joints: { type: "array", items: { type: "number" } },
          speed: { type: "number" },
          zone: { type: "string" },
          code: { type: "string" },
          rapid_code: { type: "string" },
          moduleName: { type: "string" },
          module_name: { type: "string" },
          moduleNameToBackup: { type: "string" },
          outputDir: { type: "string" },
          taskName: { type: "string" },
          listTaskMode: { type: "boolean" },
          limit: { type: "number" },
          categoryId: { type: "number" },
          allowRealExecution: { type: "boolean" },
          autoFix: { type: "boolean" },
          error_hint: { type: "string" },
        },
        required: ["action"],
      },
      execute: async (_id, params) => {
        try {
          return await handleAction(String(params.action || ""), params || {}, config || {});
        } catch (err) {
          return result(`abb_robot_real failed: ${String(err?.message || err)}`, {
            success: false,
          });
        }
      },
    });
  },
};

export default plugin;
