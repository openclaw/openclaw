import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DLL_PATH = path.join(__dirname, "src", "ABBBridge.dll");
const ABB_PLUGIN_VERSION = "1.0.1-movj.1";

const state = {
  mode: "virtual",
  connected: false,
  host: null,
  port: 7000,
  joints: [0, 0, 0, 0, 0, 0]
};

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

async function invokeBridgeSequence(method, payload, host, port) {
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
      state.connected = true;
      state.host = String(params.host ?? "virtual-controller");
      state.port = Number(params.port ?? 7000);
      return asTextResult(
        `Virtual robot connected (${state.host}:${state.port}).`,
        { mode: "virtual", connected: true, host: state.host, port: state.port }
      );
    }
    case "disconnect": {
      state.connected = false;
      return asTextResult("Virtual robot disconnected.", { mode: "virtual", connected: false });
    }
    case "get_status": {
      return asTextResult("Virtual robot status: connected.", {
        mode: "virtual",
        connected: state.connected,
        operationMode: "AUTO",
        motorState: "ON",
        rapidRunning: false
      });
    }
    case "get_joints": {
      return asTextResult(`Virtual joints: [${state.joints.join(", ")}]`, {
        mode: "virtual",
        connected: state.connected,
        joints: state.joints
      });
    }
    case "set_joints": {
      if (!Array.isArray(params.joints)) {
        return asTextResult("set_joints requires joints array.", { success: false });
      }
      state.joints = params.joints.map((x) => Number(x) || 0).slice(0, 6);
      while (state.joints.length < 6) state.joints.push(0);
      return asTextResult(`Virtual joints updated: [${state.joints.join(", ")}]`, {
        mode: "virtual",
        connected: state.connected,
        joints: state.joints
      });
    }
    case "movj": {
      if (!Array.isArray(params.joints)) {
        return asTextResult("movj requires joints array.", { success: false });
      }
      const speed = Math.max(1, Math.min(100, Number(params.speed ?? 45) || 45));
      state.joints = params.joints.map((x) => Number(x) || 0).slice(0, 6);
      while (state.joints.length < 6) state.joints.push(0);
      return asTextResult(`Virtual movj completed at speed ${speed}: [${state.joints.join(", ")}]`, {
        mode: "virtual",
        connected: state.connected,
        speed,
        joints: state.joints
      });
    }
    case "execute_rapid": {
      return asTextResult("Virtual RAPID executed.", {
        mode: "virtual",
        connected: state.connected,
        moduleName: String(params.moduleName ?? "MainModule")
      });
    }
    default:
      return asTextResult(`Virtual mode unsupported action: ${action}`, { success: false, mode: "virtual" });
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
    default:
      return asTextResult(`Real mode unsupported action: ${action}`, { success: false, mode: "real" });
  }
}

const plugin = {
  id: "abb-robot-control",
  name: "ABB Robot Control",
  description: "Control ABB real and virtual robots with one tool.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      controllerHost: { type: "string" },
      controllerPort: { type: "number", minimum: 1, maximum: 65535 },
      defaultMode: { type: "string", enum: ["virtual", "real", "auto"] }
    }
  },
  register(api, config) {
    api.registerTool({
      name: "abb_robot",
      description: "ABB robot tool supporting real and virtual modes.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          action: { type: "string" },
          mode: { type: "string", enum: ["virtual", "real", "auto"] },
          host: { type: "string" },
          port: { type: "number" },
          joints: { type: "array", items: { type: "number" } },
          speed: { type: "number" },
          zone: { type: "string" },
          code: { type: "string" },
          rapid_code: { type: "string" },
          moduleName: { type: "string" },
          module_name: { type: "string" }
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
