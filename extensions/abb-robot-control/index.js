import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DLL_PATH = path.join(__dirname, "src", "ABBBridge.dll");
const ABB_PLUGIN_VERSION = "1.0.2";

const state = {
  mode: "virtual",
  connected: false,
  host: null,
  port: 7000,
  joints: [0, 0, 0, 0, 0, 0]
};

// ── WebSocket client for virtual viewer communication ────────────────────────

let wsConn = null;
let wsRegistered = false;
const wsReplyQueue = [];
const WS_BRIDGE_DEFAULT_PORT = 9877;
const WS_INSTANCE_ID = `abb-plugin-${Date.now().toString(36)}`;

async function loadWsModule() {
  try {
    const mod = await import("ws");
    return mod.default || mod.WebSocket || mod;
  } catch {
    return globalThis.WebSocket || null;
  }
}

async function wsConnect(wsPort) {
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
        ws.send(JSON.stringify({ cmd: "register", robotId: "abb-crb-15000", instanceId: WS_INSTANCE_ID }));
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
$payload = if ([string]::IsNullOrWhiteSpace($payloadJson)) { @{} } else { ConvertFrom-Json -InputObject $payloadJson -AsHashtable }
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
      state.mode = "virtual";
      state.host = String(params.host ?? "virtual-controller");
      state.port = Number(params.port ?? WS_BRIDGE_DEFAULT_PORT);

      // Try to connect to the WebSocket bridge for viewer communication
      try {
        await wsConnect(state.port);
        state.connected = true;
        return asTextResult(
          `Virtual robot connected via WebSocket bridge (ws://127.0.0.1:${state.port}).\n` +
          `The 3D viewer will now respond to motion commands.`,
          { mode: "virtual", connected: true, host: state.host, port: state.port, wsConnected: true }
        );
      } catch (wsErr) {
        // Fallback: still mark as connected for local state tracking
        state.connected = true;
        return asTextResult(
          `Virtual robot connected (local mode). WebSocket bridge not available: ${wsErr.message}\n` +
          `Tip: Start the bridge with 'node --import tsx models/Plugin/src/ws-bridge.ts' ` +
          `and open robot_kinematic_viewer.html to enable 3D visualization.`,
          { mode: "virtual", connected: true, host: state.host, port: state.port, wsConnected: false }
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
        moduleName: String(params.moduleName ?? params.module_name ?? "MainModule")
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
      return asTextResult(
        "Available robot configurations:\n  • abb-crb-15000 — ABB CRB-15000 (6 DOF)",
        { mode: "virtual", robots: ["abb-crb-15000"] }
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
    if (!host) {
      return asTextResult("Real mode connect requires host.", { success: false, mode: "real" });
    }
    const result = await invokeBridgeSequence("GetStatus", {}, host, port);
    if (result.success) {
      state.mode = "real";
      state.connected = true;
      state.host = host;
      state.port = port;
      return asTextResult(`Real ABB robot connected/tested (${host}:${port}).`, {
        mode: "real",
        connected: true,
        host,
        port,
        status: result
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
      const joints = Array.isArray(params.joints) ? params.joints.map((x) => Number(x) || 0).slice(0, 6) : null;
      if (!joints) {
        return asTextResult("Real set_joints requires joints array.", { success: false, mode: "real" });
      }
      const result = await invokeBridgeSequence("MoveToJoints", {
        joints,
        speed: Number(params.speed ?? 100),
        zone: String(params.zone ?? "fine")
      }, state.host, state.port);
      return asTextResult(result.success ? "Real set_joints executed." : `Real set_joints failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        result
      });
    }
    case "movj": {
      const joints = Array.isArray(params.joints) ? params.joints.map((x) => Number(x) || 0).slice(0, 6) : null;
      if (!joints) {
        return asTextResult("Real movj requires joints array.", { success: false, mode: "real" });
      }
      const result = await invokeBridgeSequence("MoveToJoints", {
        joints,
        speed: Number(params.speed ?? 45),
        zone: String(params.zone ?? "fine")
      }, state.host, state.port);
      return asTextResult(result.success ? "Real movj executed." : `Real movj failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        result
      });
    }
    case "execute_rapid": {
      const code = String(params.code ?? params.rapid_code ?? "");
      if (!code) {
        return asTextResult("Real execute_rapid requires code or rapid_code.", { success: false, mode: "real" });
      }
      const result = await invokeBridgeSequence("ExecuteRapidProgram", {
        code,
        moduleName: String(params.moduleName ?? params.module_name ?? "MainModule")
      }, state.host, state.port);
      return asTextResult(result.success ? "Real RAPID executed." : `Real execute_rapid failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        result
      });
    }
    case "go_home": {
      const homeJoints = [0, 0, 0, 0, 0, 0];
      const result = await invokeBridgeSequence("MoveToJoints", {
        joints: homeJoints,
        speed: Number(params.speed ?? 100),
        zone: "fine"
      }, state.host, state.port);
      if (result.success) state.joints = homeJoints;
      return asTextResult(result.success ? "Real robot moved to home position." : `Real go_home failed: ${result.error ?? "unknown"}`, {
        mode: "real",
        connected: result.success,
        joints: homeJoints,
        result
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
      return asTextResult(
        "Available robot configurations:\n  • abb-crb-15000 — ABB CRB-15000 (6 DOF)",
        { mode: "real", robots: ["abb-crb-15000"] }
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
    "Real mode communicates with actual ABB controllers via PC SDK/C# bridge.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      controllerHost: { type: "string", description: "ABB controller IP or hostname (real mode)" },
      controllerPort: { type: "number", minimum: 1, maximum: 65535, description: "Controller port (real mode, default: 7000)" },
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
        "Real mode communicates with actual ABB controllers via PC SDK.",
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
          mode: { type: "string", enum: ["virtual", "real", "auto"], description: "Operation mode (default: auto)" },
          host: { type: "string", description: "Controller host (real) or bridge host (virtual)" },
          port: { type: "number", description: "Controller port (real: 7000) or bridge port (virtual: 9877)" },
          joints: { type: "array", items: { type: "number" }, description: "Target joint angles in degrees [J1..J6]" },
          start_joints: { type: "array", items: { type: "number" }, description: "Optional start joint angles for movj" },
          speed: { type: "number", description: "Motion speed percentage 1-100 (default: 45 for movj, 100 for set_joints)" },
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
        const effectiveMode = requestedMode === "auto" ? (state.mode || "virtual") : requestedMode;

        if (action === "connect") {
          if (!params.host && config?.controllerHost) {
            params.host = config.controllerHost;
          }
          if (!params.port && config?.controllerPort) {
            params.port = config.controllerPort;
          }
          // Pass wsBridgePort config to virtual mode
          if (!params.port && config?.wsBridgePort) {
            params.port = config.wsBridgePort;
          }
        }

        try {
          if (effectiveMode === "real") {
            return await executeReal(action, params);
          }

          if (requestedMode === "auto") {
            try {
              return await executeReal(action, params);
            } catch {
              return await executeVirtual(action, params);
            }
          }

          return await executeVirtual(action, params);
        } catch (err) {
          return asTextResult(`abb_robot failed: ${String(err?.message ?? err)}`, {
            success: false,
            action,
            mode: effectiveMode
          });
        }
      }
    });
  }
};

export default plugin;
