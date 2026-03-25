import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DLL_PATH = path.join(__dirname, "src", "ABBBridge.dll");
const ROBOTS_DIR = path.join(__dirname, "robots");
const ABB_PLUGIN_VERSION = "1.0.2";

const state = {
  mode: "virtual",
  connected: false,
  host: null,
  port: 7000,
  robotProfile: "abb-irb-120",
  joints: [0, 0, 0, 0, 0, 0]
};

const CONTROL_ACTIONS = new Set([
  "set_joints",
  "movj",
  "go_home",
  "execute_rapid",
  "motors_on",
  "motors_off",
]);

const REAL_MOTION_ACTIONS = new Set([
  "set_joints",
  "movj",
  "go_home",
]);

const ROBOT_PROFILE_CACHE = new Map();
const FALLBACK_ROBOT_PROFILES = {
  "abb-irb-120": {
    id: "abb-irb-120",
    manufacturer: "ABB",
    model: "IRB 120",
    dof: 6,
    joints: [
      { min: -165, max: 165 },
      { min: -110, max: 110 },
      { min: -110, max: 70 },
      { min: -160, max: 160 },
      { min: -120, max: 120 },
      { min: -400, max: 400 },
    ],
    dhParameters: [
      { d: 0.290, thetaOffsetDeg: 0, a: 0.000, alphaDeg: -90 },
      { d: 0.000, thetaOffsetDeg: -90, a: 0.270, alphaDeg: 0 },
      { d: 0.000, thetaOffsetDeg: 0, a: 0.070, alphaDeg: -90 },
      { d: 0.302, thetaOffsetDeg: 0, a: 0.000, alphaDeg: 90 },
      { d: 0.000, thetaOffsetDeg: 0, a: 0.000, alphaDeg: -90 },
      { d: 0.072, thetaOffsetDeg: 0, a: 0.000, alphaDeg: 0 },
    ],
    safety: {
      realSafeSpeedCap: 25,
      realMaxJointDelta: 35,
      tabletopMinTcpZ: 0.12,
    },
  },
};

// ── WebSocket client for virtual viewer communication ────────────────────────

let wsConn = null;
let wsRegistered = false;
const wsReplyQueue = [];
const WS_BRIDGE_DEFAULT_PORT = 9877;
const WS_INSTANCE_ID = `abb-plugin-${Date.now().toString(36)}`;

function normalizeRobotProfileId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return id || "abb-irb-120";
}

function listRobotProfiles() {
  const ids = new Set(Object.keys(FALLBACK_ROBOT_PROFILES));
  try {
    if (fs.existsSync(ROBOTS_DIR)) {
      for (const name of fs.readdirSync(ROBOTS_DIR)) {
        if (name.toLowerCase().endsWith(".json")) {
          ids.add(name.replace(/\.json$/i, "").toLowerCase());
        }
      }
    }
  } catch {}
  return Array.from(ids).sort();
}

function getRobotProfile(profileIdInput) {
  const profileId = normalizeRobotProfileId(profileIdInput);
  if (ROBOT_PROFILE_CACHE.has(profileId)) {
    return ROBOT_PROFILE_CACHE.get(profileId);
  }

  const fallback = FALLBACK_ROBOT_PROFILES[profileId];
  let loaded = fallback ? JSON.parse(JSON.stringify(fallback)) : null;

  try {
    const filePath = path.join(ROBOTS_DIR, `${profileId}.json`);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      loaded = parsed;
    }
  } catch {}

  if (!loaded || !Array.isArray(loaded.joints) || loaded.joints.length < 6) {
    loaded = JSON.parse(JSON.stringify(FALLBACK_ROBOT_PROFILES["abb-irb-120"]));
  }

  if (!Array.isArray(loaded.dhParameters) || loaded.dhParameters.length < 6) {
    loaded.dhParameters = FALLBACK_ROBOT_PROFILES["abb-irb-120"].dhParameters;
  }

  loaded.id = normalizeRobotProfileId(loaded.id ?? profileId);
  loaded.safety = {
    ...FALLBACK_ROBOT_PROFILES["abb-irb-120"].safety,
    ...(loaded.safety ?? {}),
  };

  ROBOT_PROFILE_CACHE.set(profileId, loaded);
  return loaded;
}

async function loadWsModule() {
  try {
    const mod = await import("ws");
    return mod.default || mod.WebSocket || mod;
  } catch {
    return globalThis.WebSocket || null;
  }
}

async function wsConnect(wsPort, robotProfileId = state.robotProfile) {
  if (wsConn && wsConn.readyState <= 1) {
    return wsConn;
  }
  const WS = await loadWsModule();
  if (!WS) {
    throw new Error("WebSocket module not available. Install 'ws' package or run in a browser.");
  }
  const port = wsPort || WS_BRIDGE_DEFAULT_PORT;
  const url = `ws://127.0.0.1:${port}`;

  return new Promise((resolve, reject) => {
    try {
      const ws = new WS(url);
      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`WebSocket connection to ${url} timed out (5s)`));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        wsConn = ws;
        wsRegistered = false;
        ws.send(JSON.stringify({
          cmd: "register",
          robotId: normalizeRobotProfileId(robotProfileId),
          instanceId: WS_INSTANCE_ID
        }));
      };

      ws.onmessage = (event) => {
        const text = typeof event.data === "string" ? event.data : event.data.toString();
        try {
          const msg = JSON.parse(text);
          if (msg.cmd === "registered") {
            wsRegistered = true;
            resolve(ws);
            return;
          }
        } catch {}
        // Deliver to waiting callers
        if (wsReplyQueue.length > 0) {
          const waiter = wsReplyQueue.shift();
          waiter.resolve(text);
        }
      };

      ws.onclose = () => {
        wsConn = null;
        wsRegistered = false;
        // Reject any pending waiters
        while (wsReplyQueue.length > 0) {
          wsReplyQueue.shift().reject(new Error("WebSocket closed"));
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message || "connection failed"}`));
      };
    } catch (err) {
      reject(new Error(`Failed to create WebSocket: ${err.message || err}`));
    }
  });
}

function wsSendAndWait(msg, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!wsConn || wsConn.readyState !== 1) {
      reject(new Error("WebSocket not connected to viewer bridge."));
      return;
    }
    const timer = setTimeout(() => {
      const idx = wsReplyQueue.findIndex((w) => w.resolve === wrappedResolve);
      if (idx >= 0) wsReplyQueue.splice(idx, 1);
      reject(new Error(`WebSocket reply timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const wrappedResolve = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    const wrappedReject = (err) => {
      clearTimeout(timer);
      reject(err);
    };

    wsReplyQueue.push({ resolve: wrappedResolve, reject: wrappedReject });
    wsConn.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        const idx = wsReplyQueue.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) wsReplyQueue.splice(idx, 1);
        reject(new Error(`WebSocket send error: ${err.message}`));
      }
    });
  });
}

function wsDisconnect() {
  if (wsConn) {
    try { wsConn.close(); } catch {}
    wsConn = null;
  }
  wsRegistered = false;
}

function degToRad(v) {
  return v * Math.PI / 180;
}

function mm(v) {
  return `${(v * 1000).toFixed(1)}mm`;
}

function matMul4(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4 + 0] * b[0 * 4 + c] +
        a[r * 4 + 1] * b[1 * 4 + c] +
        a[r * 4 + 2] * b[2 * 4 + c] +
        a[r * 4 + 3] * b[3 * 4 + c];
    }
  }
  return out;
}

function dhMatrix(theta, d, a, alpha) {
  const ct = Math.cos(theta), st = Math.sin(theta);
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  return [
    ct, -st * ca, st * sa, a * ct,
    st, ct * ca, -ct * sa, a * st,
    0, sa, ca, d,
    0, 0, 0, 1,
  ];
}

function estimateTcpZ(jointsDeg, profile) {
  if (!Array.isArray(jointsDeg) || jointsDeg.length < 6) return null;
  const dh = Array.isArray(profile?.dhParameters) ? profile.dhParameters : [];
  if (dh.length < 6) return null;
  let t = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  for (let i = 0; i < 6; i++) {
    const j = Number(jointsDeg[i] ?? 0);
    const p = dh[i];
    const theta = degToRad(j + p.thetaOffsetDeg);
    const alpha = degToRad(p.alphaDeg);
    t = matMul4(t, dhMatrix(theta, p.d, p.a, alpha));
  }
  return t[11];
}

function validateRealJointTargets(targetJoints, currentJoints, speed, profile) {
  const issues = [];
  const limits = Array.isArray(profile?.joints) ? profile.joints : [];
  const caps = {
    realSafeSpeedCap: Number(profile?.safety?.realSafeSpeedCap ?? 25),
    realMaxJointDelta: Number(profile?.safety?.realMaxJointDelta ?? 35),
    tabletopMinTcpZ: Number(profile?.safety?.tabletopMinTcpZ ?? 0.12),
  };

  for (let i = 0; i < 6; i++) {
    const v = Number(targetJoints[i] ?? 0);
    const lim = limits[i] ?? { min: -180, max: 180 };
    if (v < lim.min || v > lim.max) {
      issues.push(`J${i + 1} out of limit: ${v.toFixed(2)} (allowed ${lim.min}..${lim.max})`);
    }
  }

  const safeSpeed = Number(speed ?? 0);
  if (safeSpeed > caps.realSafeSpeedCap) {
    issues.push(`speed too high for safe mode: ${safeSpeed} (max ${caps.realSafeSpeedCap})`);
  }

  if (Array.isArray(currentJoints) && currentJoints.length >= 6) {
    for (let i = 0; i < 6; i++) {
      const delta = Math.abs(Number(targetJoints[i] ?? 0) - Number(currentJoints[i] ?? 0));
      if (delta > caps.realMaxJointDelta) {
        issues.push(`J${i + 1} step too large: ${delta.toFixed(2)}deg (max ${caps.realMaxJointDelta}deg)`);
      }
    }
  }

  const z = estimateTcpZ(targetJoints, profile);
  if (typeof z === "number" && z < caps.tabletopMinTcpZ) {
    issues.push(`estimated TCP Z too low: ${mm(z)} (min ${mm(caps.tabletopMinTcpZ)})`);
  }
  return { ok: issues.length === 0, issues, estimatedTcpZ: z };
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

async function fetchRealStatusAndLogs(host, port, limit = 8) {
  const [status, log] = await Promise.all([
    invokeBridgeSequence("GetStatus", {}, host, port),
    invokeBridgeSequence("GetEventLogEntries", { limit, categoryId: 0 }, host, port),
  ]);

  const categoryLogs = [];
  for (const categoryId of [0, 1, 2, 3, 4, 5, 6]) {
    const entry = await invokeBridgeSequence("GetEventLogEntries", { limit: Math.min(limit, 5), categoryId }, host, port);
    if (entry?.success) {
      categoryLogs.push({ categoryId, categoryName: entry.categoryName, entries: entry.entries || [] });
    }
  }

  return { status, log, categoryLogs };
}

async function waitRealMotionSettled({ host, port, baselineJoints, targetJoints, timeoutMs, pollMs, toleranceDeg, motionDetectDeg }) {
  const startedAt = Date.now();
  let observedMovement = false;
  let lastJoints = baselineJoints;
  let finalJoints = baselineJoints;

  while (Date.now() - startedAt < timeoutMs) {
    const [jRes, sRes] = await Promise.all([
      invokeBridgeSequence("GetJointPositions", {}, host, port),
      invokeBridgeSequence("GetStatus", {}, host, port),
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
        const diag = await fetchRealStatusAndLogs(host, port);
        return {
          success: true,
          observedMovement,
          settled: true,
          durationMs: Date.now() - startedAt,
          targetErrorDeg: targetErr,
          finalJoints,
          ...diag,
        };
      }
    }

    await sleep(pollMs);
  }

  const targetErr = maxJointDiff(targetJoints, finalJoints);
  const diag = await fetchRealStatusAndLogs(host, port);
  return {
    success: false,
    observedMovement,
    settled: false,
    durationMs: Date.now() - startedAt,
    targetErrorDeg: targetErr,
    finalJoints,
    ...diag,
  };
}

async function waitRealProgramIdle(host, port, timeoutMs = 60000, pollMs = 500) {
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    const status = await invokeBridgeSequence("GetStatus", {}, host, port);
    if (status.success) {
      lastStatus = status;
      if (!status.rapidRunning) {
        const diag = await fetchRealStatusAndLogs(host, port);
        return { success: true, durationMs: Date.now() - startedAt, ...diag };
      }
    }
    await sleep(pollMs);
  }
  const diag = await fetchRealStatusAndLogs(host, port);
  return { success: false, durationMs: Date.now() - startedAt, status: diag.status.success ? diag.status : lastStatus, log: diag.log };
}

function isViewerConnected() {
  return !!(wsConn && wsConn.readyState === 1);
}

async function getViewerInfoSafe() {
  if (!isViewerConnected()) return null;
  try {
    const reply = JSON.parse(await wsSendAndWait({ cmd: "get_info" }, 4000));
    return reply;
  } catch {
    return null;
  }
}

async function preflightControl(action, requestedMode, params) {
  if (!CONTROL_ACTIONS.has(action)) {
    return null;
  }

  const expectedMode = requestedMode === "auto" ? (state.mode || "virtual") : requestedMode;
  if (!state.connected) {
    return asTextResult(
      `Control precheck: robot is not connected.\n` +
      `  Requested action: ${action}\n` +
      `  Target mode: ${expectedMode}\n\n` +
      `Please prepare and confirm environment first, then connect before control:\n` +
      `  Virtual/Simulation (viewer): abb_robot action:connect mode:virtual port:9877\n` +
      `  Real robot / ABB RobotStudio: abb_robot action:connect mode:real host:<controller-ip> port:7000`,
      {
        success: false,
        precheck: true,
        environmentReady: false,
        connected: false,
        targetMode: expectedMode,
        next: "connect",
      }
    );
  }

  if (state.mode === "virtual") {
    const wsOk = isViewerConnected();
    const allowLocalOnly = params.allow_local_only === true;
    const info = await getViewerInfoSafe();
    const hasModel = info && info.hasModel === true;

    if (!wsOk && !allowLocalOnly) {
      return asTextResult(
        `Control precheck: connected mode is virtual, but viewer bridge is not connected.\n` +
        `No visible robot motion will occur.\n\n` +
        `Prepare environment and retry:\n` +
        `  1) Start ws-bridge on port 9877\n` +
        `  2) Open robot_kinematic_viewer.html and click Connect\n` +
        `  3) Load robot model (.glb)\n` +
        `If you only want local-state simulation, add allow_local_only:true.`,
        {
          success: false,
          precheck: true,
          connected: true,
          mode: "virtual",
          wsConnected: false,
          hasModel: false,
          environmentReady: false,
        }
      );
    }

    if (wsOk && !hasModel) {
      return asTextResult(
        `Control precheck: viewer is connected but robot model is not loaded.\n` +
        `Please load a .glb model in robot_kinematic_viewer.html, then retry control.`,
        {
          success: false,
          precheck: true,
          connected: true,
          mode: "virtual",
          wsConnected: true,
          hasModel: false,
          environmentReady: false,
        }
      );
    }
  }

  if (state.mode === "real" && CONTROL_ACTIONS.has(action)) {
    if (params.safety_confirmed !== true) {
      return asTextResult(
        `Control precheck: real robot mode requires explicit safety confirmation before motion.\n` +
        `Please verify environment is safe (tabletop, clearance, no human in workspace), then retry with:\n` +
        `  safety_confirmed:true`,
        {
          success: false,
          precheck: true,
          connected: true,
          mode: "real",
          environmentReady: false,
          requires: "safety_confirmed:true",
        }
      );
    }

    if (action === "execute_rapid" && params.allow_unsafe_rapid !== true) {
      return asTextResult(
        `Control precheck: execute_rapid is blocked by default in safe mode.\n` +
        `Use set_joints/movj with safety guards, or if fully reviewed add allow_unsafe_rapid:true.`,
        {
          success: false,
          precheck: true,
          connected: true,
          mode: "real",
          blockedAction: "execute_rapid",
        }
      );
    }
  }

  return null;
}

function asTextResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

function runPowerShell(script) {
  const psExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  return new Promise((resolve, reject) => {
    const child = spawn(
      psExe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || "PowerShell command failed").trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function toPsSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

const ALLOWED_BRIDGE_METHODS = new Set([
  "Connect", "Disconnect", "GetStatus", "GetJointPositions",
  "MoveToJoints", "ExecuteRapidProgram", "LoadRapidProgram",
  "StartRapid", "StopRapid", "SetMotors",
]);

async function invokeBridgeSequence(method, payload, host, port) {
  if (!ALLOWED_BRIDGE_METHODS.has(method)) {
    return { success: false, error: `Invalid bridge method: ${method}. Allowed: ${[...ALLOWED_BRIDGE_METHODS].join(", ")}` };
  }
  const payloadJson = JSON.stringify(payload ?? {});
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dllPath = '${toPsSingleQuoted(BRIDGE_DLL_PATH)}'
if (-not (Test-Path $dllPath)) {
  throw "ABBBridge.dll not found: $dllPath"
}
$bridgeDir = Split-Path -Parent $dllPath
$depCandidates = @(
  (Join-Path $bridgeDir 'ABB.Robotics.Controllers.PC.dll'),
  'C:\Program Files (x86)\ABB\SDK\PCSDK 2025\ABB.Robotics.Controllers.PC.dll',
  'C:\Program Files\ABB\SDK\PCSDK 2025\ABB.Robotics.Controllers.PC.dll'
)
$sdkResolved = $null
foreach ($dep in $depCandidates) {
  if (Test-Path $dep) {
    $sdkResolved = $dep
    break
  }
}
if ($sdkResolved) {
  $localDep = Join-Path $bridgeDir 'ABB.Robotics.Controllers.PC.dll'
  if (-not (Test-Path $localDep)) {
    Copy-Item -Path $sdkResolved -Destination $localDep -Force
  }
  [System.AppDomain]::CurrentDomain.add_AssemblyResolve({
    param($sender, $args)
    if ($args.Name -like 'ABB.Robotics.Controllers.PC,*') {
      return [System.Reflection.Assembly]::LoadFrom($sdkResolved)
    }
    return $null
  })
}
try {
  Add-Type -Path $dllPath
} catch [System.Reflection.ReflectionTypeLoadException] {
  $loaderErrors = $_.Exception.LoaderExceptions | ForEach-Object { $_.Message }
  throw ("Failed to load ABBBridge.dll. LoaderExceptions: " + ($loaderErrors -join " | "))
}
$bridge = New-Object ABBBridge
$connectPayload = @{ host='${toPsSingleQuoted(host)}'; port=${Number(port) || 7000} }
$connectResult = $bridge.Connect($connectPayload).GetAwaiter().GetResult()
if (-not $connectResult.success) {
  $connectResult | ConvertTo-Json -Depth 20 -Compress
  exit 0
}
$payloadJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadB64}'))
$payload = if ([string]::IsNullOrWhiteSpace($payloadJson)) { @{} } else { ConvertFrom-Json -InputObject $payloadJson }
$result = $bridge.${method}($payload).GetAwaiter().GetResult()
$bridge.Disconnect(@{}).GetAwaiter().GetResult() | Out-Null
$result | ConvertTo-Json -Depth 20 -Compress
`;

  const out = await runPowerShell(script);
  if (!out) {
    return { success: false, error: "No result from ABB bridge." };
  }

  try {
    return JSON.parse(out);
  } catch {
    return { success: false, error: `Unexpected bridge output: ${out}` };
  }
}

async function executeVirtual(action, params) {
  switch (action) {
    case "connect": {
      const requestedProfile = normalizeRobotProfileId(params.robot_profile ?? params.robot_id ?? state.robotProfile);
      state.robotProfile = getRobotProfile(requestedProfile).id;
      state.mode = "virtual";
      state.host = String(params.host ?? "virtual-controller");
      state.port = Number(params.port ?? WS_BRIDGE_DEFAULT_PORT);

      // Try to connect to the WebSocket bridge for viewer communication
      try {
        await wsConnect(state.port, state.robotProfile);
        state.connected = true;
        return asTextResult(
          `Virtual robot connected via WebSocket bridge (ws://127.0.0.1:${state.port}).\n` +
          `The 3D viewer will now respond to motion commands.\n` +
          `Profile: ${state.robotProfile}`,
          { mode: "virtual", connected: true, host: state.host, port: state.port, wsConnected: true, robotProfile: state.robotProfile }
        );
      } catch (wsErr) {
        // Fallback: still mark as connected for local state tracking
        state.connected = true;
        return asTextResult(
          `Virtual robot connected (local mode). WebSocket bridge not available: ${wsErr.message}\n` +
          `Tip: Start the bridge with 'node --import tsx models/Plugin/src/ws-bridge.ts' ` +
          `and open robot_kinematic_viewer.html to enable 3D visualization.\n` +
          `Profile: ${state.robotProfile}`,
          { mode: "virtual", connected: true, host: state.host, port: state.port, wsConnected: false, robotProfile: state.robotProfile }
        );
      }
    }
    case "disconnect": {
      state.connected = false;
      wsDisconnect();
      return asTextResult("Virtual robot disconnected.", { mode: "virtual", connected: false });
    }
    case "get_status": {
      const wsOk = wsConn && wsConn.readyState === 1;
      return asTextResult(
        `Virtual robot status:\n` +
        `  Connected: ${state.connected}\n` +
        `  Mode: virtual\n` +
        `  WebSocket bridge: ${wsOk ? "connected" : "not connected"}\n` +
        `  Operation: AUTO\n` +
        `  Motors: ON`,
        {
          mode: "virtual",
          connected: state.connected,
          wsConnected: wsOk,
          operationMode: "AUTO",
          motorState: "ON",
          rapidRunning: false
        }
      );
    }
    case "get_joints": {
      // Try to get joints from the viewer via WebSocket
      if (wsConn && wsConn.readyState === 1) {
        try {
          const reply = JSON.parse(await wsSendAndWait({ cmd: "get_joints" }, 5000));
          if (Array.isArray(reply.joints)) {
            state.joints = reply.joints;
          }
        } catch {}
      }
      return asTextResult(`Virtual joints: [${state.joints.map((v) => v.toFixed(2)).join(", ")}]`, {
        mode: "virtual",
        connected: state.connected,
        joints: state.joints
      });
    }
    case "set_joints": {
      if (!Array.isArray(params.joints)) {
        return asTextResult("set_joints requires joints array.", { success: false });
      }
      const joints = params.joints.map((x) => Number(x) || 0).slice(0, 6);
      while (joints.length < 6) joints.push(0);
      state.joints = joints;

      // Send to viewer via WebSocket bridge
      if (wsConn && wsConn.readyState === 1) {
        try {
          await wsSendAndWait({ cmd: "set_joints", joints }, 5000);
          return asTextResult(
            `Virtual joints set (viewer updated): [${joints.map((v) => v.toFixed(2)).join(", ")}]`,
            { mode: "virtual", connected: true, joints, viewerUpdated: true }
          );
        } catch (err) {
          return asTextResult(
            `Virtual joints set (local only, viewer error: ${err.message}): [${joints.join(", ")}]`,
            { mode: "virtual", connected: true, joints, viewerUpdated: false }
          );
        }
      }
      return asTextResult(`Virtual joints set (no viewer): [${joints.join(", ")}]`, {
        mode: "virtual",
        connected: state.connected,
        joints,
        viewerUpdated: false
      });
    }
    case "movj": {
      if (!Array.isArray(params.joints)) {
        return asTextResult("movj requires joints array.", { success: false });
      }
      const targetJoints = params.joints.map((x) => Number(x) || 0).slice(0, 6);
      while (targetJoints.length < 6) targetJoints.push(0);
      const speed = Math.max(1, Math.min(100, Number(params.speed ?? 45) || 45));
      const startJoints = Array.isArray(params.start_joints)
        ? params.start_joints.map((x) => Number(x) || 0).slice(0, 6)
        : null;

      // Send movj to viewer via WebSocket bridge for smooth animated motion
      if (wsConn && wsConn.readyState === 1) {
        try {
          const wsMsg = {
            cmd: "movj",
            joints: targetJoints,
            speed,
          };
          if (startJoints) wsMsg.start_joints = startJoints;

          const replyText = await wsSendAndWait(wsMsg, 15000);
          const reply = JSON.parse(replyText);

          if (String(reply.cmd ?? "") === "error") {
            throw new Error(`viewer movj failed: ${String(reply.error ?? "unknown error")}`);
          }
          if (String(reply.cmd ?? "") !== "movj_done") {
            throw new Error(`unexpected viewer reply: ${String(reply.cmd ?? "(missing)")}`);
          }

          state.joints = Array.isArray(reply.joints) ? reply.joints : targetJoints;

          const cancelled = reply.cancelled ? " (cancelled by new command)" : "";
          return asTextResult(
            `Virtual movj completed${cancelled}.\n` +
            `  Speed: ${reply.speed ?? speed}%\n` +
            `  Duration: ${reply.durationMs ?? "?"}ms\n` +
            `  End joints: [${state.joints.map((v) => v.toFixed(2)).join(", ")}]`,
            {
              mode: "virtual",
              connected: true,
              speed: reply.speed ?? speed,
              durationMs: reply.durationMs,
              cancelled: !!reply.cancelled,
              joints: state.joints,
              viewerUpdated: true
            }
          );
        } catch (err) {
          // Fallback to local-only state update
          state.joints = targetJoints;
          return asTextResult(
            `Virtual movj (local only, viewer error: ${err.message}).\n` +
            `  Speed: ${speed}%\n` +
            `  End joints: [${targetJoints.join(", ")}]`,
            { mode: "virtual", connected: true, speed, joints: targetJoints, viewerUpdated: false }
          );
        }
      }

      // No WebSocket connection: local-only
      state.joints = targetJoints;
      return asTextResult(
        `Virtual movj (no viewer connected).\n` +
        `  Speed: ${speed}%\n` +
        `  End joints: [${targetJoints.join(", ")}]\n` +
        `  Tip: Connect to the WebSocket bridge for 3D animation.`,
        { mode: "virtual", connected: state.connected, speed, joints: targetJoints, viewerUpdated: false }
      );
    }
    case "go_home": {
      const homeJoints = [0, 0, 0, 0, 0, 0];
      if (wsConn && wsConn.readyState === 1) {
        try {
          await wsSendAndWait({ cmd: "home" }, 5000);
          state.joints = homeJoints;
          return asTextResult("Virtual robot moved to home position (viewer updated).", {
            mode: "virtual", connected: true, joints: homeJoints, viewerUpdated: true
          });
        } catch {}
      }
      state.joints = homeJoints;
      return asTextResult("Virtual robot moved to home position.", {
        mode: "virtual", connected: state.connected, joints: homeJoints
      });
    }
    case "execute_rapid": {
      return asTextResult("Virtual RAPID executed (simulated).", {
        mode: "virtual",
        connected: state.connected,
        moduleName: String(params.moduleName ?? params.module_name ?? "OpenClawMotionMod")
      });
    }
    case "motors_on":
    case "motors_off": {
      const motorState = action === "motors_on" ? "ON" : "OFF";
      return asTextResult(`Virtual motors turned ${motorState.toLowerCase()}.`, {
        mode: "virtual", connected: state.connected, motorState
      });
    }
    case "list_robots": {
      const profiles = listRobotProfiles();
      return asTextResult(
        `Available robot configurations:\n  ${profiles.map((id) => `• ${id}`).join("\n")}`,
        { mode: "virtual", robots: profiles, activeProfile: state.robotProfile }
      );
    }
    default:
      return asTextResult(`Virtual mode: action '${action}' not supported in virtual mode.`, {
        success: false, mode: "virtual", action
      });
  }
}

async function executeReal(action, params) {
  if (action === "connect") {
    const host = String(params.host ?? "").trim();
    const port = Number(params.port ?? 7000);
    const allowVirtualController = params.allowVirtualController === true;
    const requestedProfile = normalizeRobotProfileId(params.robot_profile ?? params.robot_id ?? state.robotProfile);
    state.robotProfile = getRobotProfile(requestedProfile).id;
    if (!host) {
      return asTextResult("Real mode connect requires host.", { success: false, mode: "real" });
    }
    const result = await invokeBridgeSequence("GetStatus", {}, host, port);
    if (result.success) {
      const scan = await invokeBridgeSequence("ScanControllers", {}, host, port);
      const localHostRequested = ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
      const matchedController = scan?.success
        ? (scan.controllers || []).find((c) => {
            const ip = String(c?.ip || "").toLowerCase();
            const id = String(c?.id || "").toLowerCase();
            const sys = String(c?.systemId || "").toLowerCase();
            const name = String(c?.systemName || "").toLowerCase();
            const target = host.toLowerCase();
            return ip === target || id === target || sys === target || name === target || (localHostRequested && c?.isVirtual);
          })
        : null;

      if (!allowVirtualController && matchedController?.isVirtual) {
        state.mode = "real";
        state.connected = false;
        return asTextResult(
          `Real connect rejected: target '${host}' resolves to a virtual controller (${matchedController.systemName || "unknown"}). ` +
          `Use a real controller IP/ID, or set allowVirtualController=true only for debugging.`,
          {
            mode: "real",
            connected: false,
            virtualControllerDetected: true,
            host,
            port,
            matchedController,
            scan,
            result,
          }
        );
      }

      state.mode = "real";
      state.connected = true;
      state.host = host;
      state.port = port;
      return asTextResult(`Real ABB robot connected/tested (${host}:${port}).`, {
        mode: "real",
        connected: true,
        host,
        port,
        robotProfile: state.robotProfile,
        status: result,
        controller: matchedController || null
      });
    }
    return asTextResult(`Real connect failed: ${result.error ?? "unknown error"}`, {
      mode: "real",
      connected: false,
      result
    });
  }

  if (action === "disconnect") {
    state.connected = false;
    return asTextResult("Real mode session disconnected.", { mode: "real", connected: false });
  }

  if (!state.connected || !state.host) {
    return asTextResult("Real mode not connected. Run connect with host first.", {
      success: false,
      mode: "real"
    });
  }

  switch (action) {
    case "get_status": {
      const result = await invokeBridgeSequence("GetStatus", {}, state.host, state.port);
      return asTextResult(result.success ? "Real status fetched." : `Real status failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        result
      });
    }
    case "get_joints": {
      const result = await invokeBridgeSequence("GetJointPositions", {}, state.host, state.port);
      if (result.success && Array.isArray(result.joints)) {
        state.joints = result.joints;
      }
      return asTextResult(result.success ? `Real joints: [${(result.joints ?? []).join(", ")}]` : `Real get_joints failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        result
      });
    }
    case "set_joints": {
      const profile = getRobotProfile(state.robotProfile);
      const speedCap = Number(profile?.safety?.realSafeSpeedCap ?? 25);
      const joints = Array.isArray(params.joints) ? params.joints.map((x) => Number(x) || 0).slice(0, 6) : null;
      if (!joints) {
        return asTextResult("Real set_joints requires joints array.", { success: false, mode: "real" });
      }
      const safeSpeed = Math.max(1, Math.min(speedCap, Number(params.speed ?? 20) || 20));
      const current = await invokeBridgeSequence("GetJointPositions", {}, state.host, state.port);
      const currentJoints = Array.isArray(current.joints) ? current.joints : null;
      const check = validateRealJointTargets(joints, currentJoints, safeSpeed, profile);
      if (!check.ok) {
        return asTextResult(
          `Real set_joints blocked by safety policy:\n  - ${check.issues.join("\n  - ")}`,
          { success: false, mode: "real", blockedBySafety: true, issues: check.issues, estimatedTcpZ: check.estimatedTcpZ }
        );
      }
      const result = await invokeBridgeSequence("MoveToJoints", {
        joints,
        speed: safeSpeed,
        zone: String(params.zone ?? "fine")
      }, state.host, state.port);
      if (!result.success) {
        const diag = await fetchRealStatusAndLogs(state.host, state.port);
        return asTextResult(`Real set_joints failed: ${result.error ?? "unknown"}`, {
          mode: "real",
          connected: false,
          result,
          ...diag,
        });
      }

      const verify = await waitRealMotionSettled({
        host: state.host,
        port: state.port,
        baselineJoints: currentJoints || joints,
        targetJoints: joints,
        timeoutMs: Math.max(3000, Math.min(120000, Number(params.motionTimeoutMs ?? 30000))),
        pollMs: Math.max(100, Math.min(2000, Number(params.pollIntervalMs ?? 400))),
        toleranceDeg: Math.max(0.05, Math.min(5, Number(params.toleranceDeg ?? 0.4))),
        motionDetectDeg: Math.max(0.05, Math.min(5, Number(params.motionDetectDeg ?? 0.2))),
      });

      if (!verify.success) {
        const noMotion = !verify.observedMovement && maxJointDiff(joints, currentJoints || joints) > 0.2;
        const reason = noMotion ? "No robot motion observed after command dispatch" : "Motion did not settle within timeout";
        return asTextResult(`Real set_joints verification failed: ${reason}`, {
          mode: "real",
          connected: false,
          verificationFailed: true,
          reason,
          result,
          verification: verify,
        });
      }

      return asTextResult("Real set_joints executed and verified complete.", {
        mode: "real",
        connected: true,
        result,
        verification: verify,
      });
    }
    case "movj": {
      const profile = getRobotProfile(state.robotProfile);
      const speedCap = Number(profile?.safety?.realSafeSpeedCap ?? 25);
      const joints = Array.isArray(params.joints) ? params.joints.map((x) => Number(x) || 0).slice(0, 6) : null;
      if (!joints) {
        return asTextResult("Real movj requires joints array.", { success: false, mode: "real" });
      }
      const safeSpeed = Math.max(1, Math.min(speedCap, Number(params.speed ?? 15) || 15));
      const current = await invokeBridgeSequence("GetJointPositions", {}, state.host, state.port);
      const currentJoints = Array.isArray(current.joints) ? current.joints : null;
      const check = validateRealJointTargets(joints, currentJoints, safeSpeed, profile);
      if (!check.ok) {
        return asTextResult(
          `Real movj blocked by safety policy:\n  - ${check.issues.join("\n  - ")}`,
          { success: false, mode: "real", blockedBySafety: true, issues: check.issues, estimatedTcpZ: check.estimatedTcpZ }
        );
      }
      const result = await invokeBridgeSequence("MoveToJoints", {
        joints,
        speed: safeSpeed,
        zone: String(params.zone ?? "fine")
      }, state.host, state.port);
      if (!result.success) {
        const diag = await fetchRealStatusAndLogs(state.host, state.port);
        return asTextResult(`Real movj failed: ${result.error ?? "unknown"}`, {
          mode: "real",
          connected: false,
          result,
          ...diag,
        });
      }

      const verify = await waitRealMotionSettled({
        host: state.host,
        port: state.port,
        baselineJoints: currentJoints || joints,
        targetJoints: joints,
        timeoutMs: Math.max(3000, Math.min(120000, Number(params.motionTimeoutMs ?? 30000))),
        pollMs: Math.max(100, Math.min(2000, Number(params.pollIntervalMs ?? 400))),
        toleranceDeg: Math.max(0.05, Math.min(5, Number(params.toleranceDeg ?? 0.4))),
        motionDetectDeg: Math.max(0.05, Math.min(5, Number(params.motionDetectDeg ?? 0.2))),
      });

      if (!verify.success) {
        const noMotion = !verify.observedMovement && maxJointDiff(joints, currentJoints || joints) > 0.2;
        const reason = noMotion ? "No robot motion observed after command dispatch" : "Motion did not settle within timeout";
        return asTextResult(`Real movj verification failed: ${reason}`, {
          mode: "real",
          connected: false,
          verificationFailed: true,
          reason,
          result,
          verification: verify,
        });
      }

      return asTextResult("Real movj executed and verified complete.", {
        mode: "real",
        connected: true,
        result,
        verification: verify,
      });
    }
    case "execute_rapid": {
      const code = String(params.code ?? params.rapid_code ?? "");
      if (!code) {
        return asTextResult("Real execute_rapid requires code or rapid_code.", { success: false, mode: "real" });
      }
      const result = await invokeBridgeSequence("ExecuteRapidProgram", {
        code,
        moduleName: String(params.moduleName ?? params.module_name ?? "OpenClawMotionMod")
      }, state.host, state.port);
      return asTextResult(result.success ? "Real RAPID executed." : `Real execute_rapid failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        result
      });
    }
    case "go_home": {
      const profile = getRobotProfile(state.robotProfile);
      const speedCap = Number(profile?.safety?.realSafeSpeedCap ?? 25);
      const homeJoints = [0, 0, 0, 0, 0, 0];
      const safeSpeed = Math.max(1, Math.min(speedCap, Number(params.speed ?? 12) || 12));
      const current = await invokeBridgeSequence("GetJointPositions", {}, state.host, state.port);
      const currentJoints = Array.isArray(current.joints) ? current.joints : null;
      const check = validateRealJointTargets(homeJoints, currentJoints, safeSpeed, profile);
      if (!check.ok) {
        return asTextResult(
          `Real go_home blocked by safety policy:\n  - ${check.issues.join("\n  - ")}`,
          { success: false, mode: "real", blockedBySafety: true, issues: check.issues, estimatedTcpZ: check.estimatedTcpZ }
        );
      }
      const result = await invokeBridgeSequence("MoveToJoints", {
        joints: homeJoints,
        speed: safeSpeed,
        zone: "fine"
      }, state.host, state.port);
      if (!result.success) {
        const diag = await fetchRealStatusAndLogs(state.host, state.port);
        return asTextResult(`Real go_home failed: ${result.error ?? "unknown"}`, {
          mode: "real",
          connected: false,
          joints: homeJoints,
          result,
          ...diag,
        });
      }

      const verify = await waitRealMotionSettled({
        host: state.host,
        port: state.port,
        baselineJoints: currentJoints || homeJoints,
        targetJoints: homeJoints,
        timeoutMs: Math.max(3000, Math.min(120000, Number(params.motionTimeoutMs ?? 30000))),
        pollMs: Math.max(100, Math.min(2000, Number(params.pollIntervalMs ?? 400))),
        toleranceDeg: Math.max(0.05, Math.min(5, Number(params.toleranceDeg ?? 0.4))),
        motionDetectDeg: Math.max(0.05, Math.min(5, Number(params.motionDetectDeg ?? 0.2))),
      });

      if (!verify.success) {
        return asTextResult("Real go_home verification failed: Motion did not settle within timeout", {
          mode: "real",
          connected: false,
          joints: homeJoints,
          result,
          verification: verify,
        });
      }

      state.joints = homeJoints;
      return asTextResult("Real robot moved to home position and verified complete.", {
        mode: "real",
        connected: true,
        joints: homeJoints,
        result,
        verification: verify,
      });
    }
    case "motors_on":
    case "motors_off": {
      const motorState = action === "motors_on" ? "ON" : "OFF";
      const result = await invokeBridgeSequence("SetMotors", {
        state: motorState
      }, state.host, state.port);
      return asTextResult(
        result.success
          ? `Real motors turned ${motorState.toLowerCase()}.`
          : `Motor control: ${result.error ?? "not available in PCSDK 2025"}`,
        { mode: "real", connected: state.connected, motorState, result }
      );
    }
    case "list_robots": {
      const profiles = listRobotProfiles();
      return asTextResult(
        `Available robot configurations:\n  ${profiles.map((id) => `• ${id}`).join("\n")}`,
        { mode: "real", robots: profiles, activeProfile: state.robotProfile }
      );
    }
    default:
      return asTextResult(`Real mode unsupported action: ${action}`, { success: false, mode: "real" });
  }
}

const plugin = {
  id: "abb-robot-control",
  name: "ABB Robot Control",
  description:
    "Control ABB robots in real and virtual modes. " +
    "Virtual mode connects to the 3D kinematic viewer via WebSocket for " +
    "smooth animated motion (movj with speed control). " +
    "Real mode communicates with actual ABB controllers via PC SDK/C# bridge. " +
    "When connect mode is auto and a real target host is explicitly provided, " +
    "auto fallback to virtual is suppressed and real connection errors are returned directly.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      controllerHost: { type: "string", description: "ABB controller IP or hostname (real mode)" },
      controllerPort: { type: "number", minimum: 1, maximum: 65535, description: "Controller port (real mode, default: 7000)" },
      defaultRobot: { type: "string", description: "Default robot profile id (e.g. abb-irb-120)" },
      defaultMode: { type: "string", enum: ["virtual", "real", "auto"], description: "Default mode (default: auto)" },
      wsBridgePort: { type: "number", minimum: 1, maximum: 65535, description: "WebSocket bridge port for virtual mode (default: 9877)" }
    }
  },
  register(api, config) {
    api.registerTool({
      name: "abb_robot",
      description:
        "Control ABB robots. Actions: connect, disconnect, get_status, get_joints, " +
        "set_joints, movj (smooth joint motion with speed), go_home, execute_rapid, " +
        "motors_on, motors_off, list_robots, get_version. " +
        "Virtual mode sends commands to the 3D viewer via WebSocket for animated motion. " +
        "Real mode communicates with actual ABB controllers via PC SDK. " +
        "Use mode:real for physical robot operations.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          action: {
            type: "string",
            description:
              "The action to perform: connect, disconnect, get_status, get_joints, " +
              "set_joints, movj, go_home, execute_rapid, motors_on, motors_off, " +
              "list_robots, get_version"
          },
          mode: { type: "string", enum: ["virtual", "real", "auto"], description: "Operation mode. Use real for physical robot control; auto is for convenience." },
          host: { type: "string", description: "Controller host (real) or bridge host (virtual)" },
          port: { type: "number", description: "Controller port (real: 7000) or bridge port (virtual: 9877)" },
          robot_id: { type: "string", description: "Robot profile id (legacy alias)" },
          robot_profile: { type: "string", description: "Robot profile id for safety limits/DH (e.g. abb-irb-120)" },
          joints: { type: "array", items: { type: "number" }, description: "Target joint angles in degrees [J1..J6]" },
          start_joints: { type: "array", items: { type: "number" }, description: "Optional start joint angles for movj" },
          speed: { type: "number", description: "Motion speed percentage 1-100 (default: 45 for movj, 100 for set_joints)" },
          allow_local_only: { type: "boolean", description: "Allow local-only virtual simulation when viewer bridge/model is not ready" },
          safety_confirmed: { type: "boolean", description: "Required true for real robot control actions" },
          allow_unsafe_rapid: { type: "boolean", description: "Allow execute_rapid in real mode (unsafe, default false)" },
          zone: { type: "string", description: "Zone parameter for real mode (fine/z10/blended)" },
          code: { type: "string", description: "RAPID program code" },
          rapid_code: { type: "string", description: "RAPID program code (alias)" },
          moduleName: { type: "string", description: "RAPID module name" },
          module_name: { type: "string", description: "RAPID module name (alias)" }
        },
        required: ["action"]
      },
      execute: async (_id, params) => {
        const action = String(params?.action ?? "").trim();
        if (!action) {
          return asTextResult("Missing action.", { success: false });
        }

        if (action === "get_version") {
          return asTextResult(`abb_robot plugin version: ${ABB_PLUGIN_VERSION}`, {
            success: true,
            plugin: "abb-robot-control",
            version: ABB_PLUGIN_VERSION
          });
        }

        const requestedMode = String(params?.mode ?? config?.defaultMode ?? "auto").toLowerCase();

        if (!params.robot_profile && !params.robot_id && config?.defaultRobot) {
          params.robot_profile = config.defaultRobot;
        }

        const precheck = await preflightControl(action, requestedMode, params);
        if (precheck) {
          return precheck;
        }

        if (action === "connect") {
          if (requestedMode === "virtual") {
            // Virtual mode should prefer WebSocket bridge port (9877), not controllerPort.
            if (!params.port) {
              params.port = config?.wsBridgePort ?? WS_BRIDGE_DEFAULT_PORT;
            }
            if (!params.host) {
              params.host = "127.0.0.1";
            }
          } else if (requestedMode === "real") {
            if (!params.host && config?.controllerHost) {
              params.host = config.controllerHost;
            }
            if (!params.port && config?.controllerPort) {
              params.port = config.controllerPort;
            }
          } else {
            // Auto mode: keep real defaults for first attempt, then virtual fallback will set bridge defaults.
            if (!params.host && config?.controllerHost) {
              params.host = config.controllerHost;
            }
            if (!params.port && config?.controllerPort) {
              params.port = config.controllerPort;
            }
          }
        }

        try {
          if (requestedMode === "auto") {
            // Connect in auto: try real first, then fall back to virtual bridge mode.
            if (action === "connect") {
              const requestedHost = String(params?.host ?? "").trim();
              const configuredHost = String(config?.controllerHost ?? "").trim();
              // If caller/config explicitly points to a real controller, do not silently downgrade to virtual.
              const preferRealOnly =
                requestedHost.length > 0 ||
                configuredHost.length > 0 ||
                params?.safety_confirmed === true;

              try {
                const realResult = await executeReal(action, params);
                if (realResult?.details?.connected) return realResult;
                if (preferRealOnly) {
                  return asTextResult(
                    `Auto connect attempted REAL mode and failed; no virtual fallback was applied.\n` +
                    `Reason: ${realResult?.details?.result?.error ?? "unknown"}`,
                    {
                      ...(realResult?.details ?? {}),
                      mode: "real",
                      fallbackSuppressed: true,
                      target: "real"
                    }
                  );
                }
              } catch (realErr) {
                if (preferRealOnly) {
                  return asTextResult(
                    `Auto connect attempted REAL mode and failed with an exception; no virtual fallback was applied.\n` +
                    `Reason: ${String(realErr?.message ?? realErr)}`,
                    {
                      success: false,
                      mode: "real",
                      fallbackSuppressed: true,
                      target: "real",
                      error: String(realErr?.message ?? realErr),
                      attemptedHost: requestedHost || configuredHost || null
                    }
                  );
                }
              }

              const vParams = { ...params };
              if (!vParams.port) vParams.port = config?.wsBridgePort ?? WS_BRIDGE_DEFAULT_PORT;
              if (!vParams.host) vParams.host = "127.0.0.1";
              return await executeVirtual(action, vParams);
            }

            // Non-connect actions in auto should follow current state mode.
            if (state.mode === "real") {
              return await executeReal(action, params);
            }
            return await executeVirtual(action, params);
          }

          if (requestedMode === "real") {
            return await executeReal(action, params);
          }

          if (requestedMode === "virtual") {
            return await executeVirtual(action, params);
          }

          return await executeVirtual(action, params);
        } catch (err) {
          return asTextResult(`abb_robot failed: ${String(err?.message ?? err)}`, {
            success: false,
            action,
            mode: requestedMode
          });
        }
      }
    });
  }
};

export default plugin;
