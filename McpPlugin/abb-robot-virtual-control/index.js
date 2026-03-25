import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const VERSION = "1.0.0";
const DEFAULT_PORT = 9877;
const state = {
  connected: false,
  host: "127.0.0.1",
  port: DEFAULT_PORT,
  robotId: "abb-crb-15000",
  joints: [0, 0, 0, 0, 0, 0],
};

let wsConn = null;
const queue = [];
const instanceId = `abb-virtual-${Date.now().toString(36)}`;

function result(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

async function loadWs() {
  const mod = await import("ws");
  return mod.default || mod.WebSocket || mod;
}

async function wsConnect(port, robotId) {
  if (wsConn && wsConn.readyState <= 1) {
    return wsConn;
  }
  const WS = await loadWs();
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("WebSocket connect timeout"));
    }, 4000);

    ws.onopen = () => {
      clearTimeout(timer);
      wsConn = ws;
      ws.send(JSON.stringify({ cmd: "register", robotId, instanceId }));
    };

    ws.onmessage = (evt) => {
      const msg = typeof evt.data === "string" ? evt.data : evt.data.toString();
      try {
        const obj = JSON.parse(msg);
        if (obj.cmd === "registered") {
          resolve(ws);
          return;
        }
      } catch {}
      if (queue.length > 0) {
        queue.shift().resolve(msg);
      }
    };

    ws.onclose = () => {
      wsConn = null;
      while (queue.length > 0) {
        queue.shift().reject(new Error("WebSocket closed"));
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(err?.message || "WebSocket error"));
    };
  });
}

function wsSendAndWait(msg, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!wsConn || wsConn.readyState !== 1) {
      reject(new Error("WebSocket not connected"));
      return;
    }
    const item = { resolve, reject };
    queue.push(item);
    const timer = setTimeout(() => {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      reject(new Error("WebSocket timeout"));
    }, timeoutMs);

    const wrappedResolve = (data) => { clearTimeout(timer); resolve(data); };
    const wrappedReject = (err) => { clearTimeout(timer); reject(err); };
    item.resolve = wrappedResolve;
    item.reject = wrappedReject;

    wsConn.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        wrappedReject(err);
      }
    });
  });
}

async function execute(action, params) {
  switch (action) {
    case "connect": {
      state.host = String(params.host || "127.0.0.1");
      state.port = Number(params.port || DEFAULT_PORT);
      state.robotId = String(params.robot_id || params.robot_profile || state.robotId || "abb-crb-15000");
      try {
        await wsConnect(state.port, state.robotId);
        state.connected = true;
        return result(`Virtual plugin connected: ws://127.0.0.1:${state.port} (${state.robotId})`, {
          success: true,
          connected: true,
          mode: "virtual",
          robotId: state.robotId,
          port: state.port,
        });
      } catch (err) {
        state.connected = true;
        return result(`Virtual connected (local only): ${String(err?.message || err)}`, {
          success: true,
          connected: true,
          mode: "virtual",
          wsConnected: false,
        });
      }
    }
    case "disconnect": {
      state.connected = false;
      if (wsConn) {
        try { wsConn.close(); } catch {}
      }
      wsConn = null;
      return result("Virtual plugin disconnected.", { success: true, connected: false, mode: "virtual" });
    }
    case "get_status": {
      const wsConnected = !!(wsConn && wsConn.readyState === 1);
      return result("Virtual status fetched.", {
        success: true,
        connected: state.connected,
        mode: "virtual",
        wsConnected,
      });
    }
    case "get_joints": {
      if (wsConn && wsConn.readyState === 1) {
        try {
          const reply = JSON.parse(await wsSendAndWait({ cmd: "get_joints" }, 5000));
          if (Array.isArray(reply.joints)) state.joints = reply.joints;
        } catch {}
      }
      return result(`Virtual joints: [${state.joints.join(", ")}]`, {
        success: true,
        mode: "virtual",
        joints: state.joints,
      });
    }
    case "set_joints": {
      const joints = Array.isArray(params.joints) ? params.joints.map((x) => Number(x) || 0).slice(0, 6) : null;
      if (!joints) return result("set_joints requires joints array.", { success: false });
      while (joints.length < 6) joints.push(0);
      state.joints = joints;
      if (wsConn && wsConn.readyState === 1) {
        await wsSendAndWait({ cmd: "set_joints", joints }, 5000);
      }
      return result("Virtual set_joints done.", { success: true, mode: "virtual", joints });
    }
    case "movj": {
      const joints = Array.isArray(params.joints) ? params.joints.map((x) => Number(x) || 0).slice(0, 6) : null;
      if (!joints) return result("movj requires joints array.", { success: false });
      while (joints.length < 6) joints.push(0);
      const speed = Math.max(1, Math.min(100, Number(params.speed || 45)));
      state.joints = joints;
      if (wsConn && wsConn.readyState === 1) {
        try {
          const reply = JSON.parse(await wsSendAndWait({ cmd: "movj", joints, speed }, 15000));
          if (reply.cmd === "error") {
            return result(`Virtual movj failed: ${reply.error || "unknown"}`, { success: false, mode: "virtual" });
          }
        } catch (wsErr) {
          // viewer not responding - execute locally
          return result(`Virtual movj executed (local): ${String(wsErr?.message || wsErr)}`, { success: true, mode: "virtual", joints, speed });
        }
      }
      return result("Virtual movj executed.", { success: true, mode: "virtual", joints, speed });
    }
    case "go_home": {
      const joints = [0, 0, 0, 0, 0, 0];
      state.joints = joints;
      if (wsConn && wsConn.readyState === 1) {
        try { await wsSendAndWait({ cmd: "home" }, 5000); } catch {}
      }
      return result("Virtual go_home done.", { success: true, mode: "virtual", joints });
    }
    case "list_robots": {
      return result("Virtual available robots: abb-crb-15000", {
        success: true,
        mode: "virtual",
        robots: ["abb-crb-15000"],
      });
    }
    case "get_version": {
      return result(`abb_robot_virtual version: ${VERSION}`, {
        success: true,
        version: VERSION,
      });
    }
    default:
      return result(`Unsupported virtual action: ${action}`, { success: false, mode: "virtual" });
  }
}

const plugin = {
  id: "abb-robot-virtual-control",
  name: "ABB Robot Virtual Control",
  description: "Independent virtual ABB viewer control plugin.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      wsBridgePort: { type: "number", minimum: 1, maximum: 65535 },
      defaultRobot: { type: "string" },
    },
  },
  register(api, config) {
    if (config?.wsBridgePort) state.port = Number(config.wsBridgePort);
    if (config?.defaultRobot) state.robotId = String(config.defaultRobot);
    api.registerTool({
      name: "abb_robot_virtual",
      description: "Virtual ABB robot control only (ws-bridge/viewer).",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          action: { type: "string" },
          host: { type: "string" },
          port: { type: "number" },
          joints: { type: "array", items: { type: "number" } },
          speed: { type: "number" },
          robot_id: { type: "string" },
          robot_profile: { type: "string" }
        },
        required: ["action"],
      },
      execute: async (_id, params) => execute(String(params.action || ""), params || {}),
    });
  },
};

export default plugin;
