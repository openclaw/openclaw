import fs from "node:fs";
import plugin from "../extensions/abb-robot-real-control/index.js";

const action = process.argv[2];
const paramsArg = process.argv[3] || "{}";

if (!action) {
  console.log(JSON.stringify({ ok: false, error: "missing action" }));
  process.exit(2);
}

let params = {};
try {
  if (paramsArg.startsWith("@")) {
    const filePath = paramsArg.slice(1);
    const content = fs
      .readFileSync(filePath, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    params = JSON.parse(content || "{}");
  } else {
    params = JSON.parse(paramsArg);
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `invalid params json: ${e.message}` }));
  process.exit(2);
}

let tool;
plugin.register(
  {
    registerTool: (t) => {
      tool = t;
    },
  },
  {
    controllerHost: "127.0.0.1",
    controllerPort: 7000,
    bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll",
  },
);

try {
  const allowVirtualController = params.allowVirtualController ?? true;

  if (!["scan_controllers", "connect", "disconnect", "get_version"].includes(action)) {
    await tool.execute("bootstrap-connect", {
      action: "connect",
      host: "127.0.0.1",
      port: 7000,
      allowVirtualController,
    });
  }
  const effectiveParams = action === "connect" ? { allowVirtualController, ...params } : params;
  const res = await tool.execute(`once-${action}`, { action, ...effectiveParams });
  const text = String(res?.content?.[0]?.text ?? "");
  console.log(JSON.stringify({ ok: true, action, text, details: res?.details ?? {} }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, action, error: e?.message ?? String(e) }));
  process.exit(1);
}
