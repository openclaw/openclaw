import plugin from "../extensions/abb-robot-virtual-control/index.js";

let tool = null;
plugin.register(
  {
    registerTool: (t) => {
      tool = t;
    },
  },
  { wsBridgePort: 9877, defaultRobot: "abb-crb-15000" },
);

async function run() {
  const c = await tool.execute("1", {
    action: "connect",
    host: "127.0.0.1",
    port: 9877,
    robot_id: "abb-crb-15000",
  });
  const b = await tool.execute("2", { action: "get_joints" });
  const m = await tool.execute("3", {
    action: "movj",
    joints: [8, 0, 0, 0, 0, 0],
    speed: 20,
  });
  const a = await tool.execute("4", { action: "get_joints" });

  console.log("MAIN_VIRTUAL_CONNECT", JSON.stringify(c?.details ?? {}));
  console.log("MAIN_VIRTUAL_BEFORE", JSON.stringify(b?.details ?? {}));
  console.log("MAIN_VIRTUAL_MOVJ", JSON.stringify(m?.details ?? {}));
  console.log("MAIN_VIRTUAL_AFTER", JSON.stringify(a?.details ?? {}));

  const ok =
    c?.details?.connected === true &&
    m?.details?.success === true &&
    Array.isArray(a?.details?.joints);
  console.log(ok ? "MAIN_VIRTUAL_OK" : "MAIN_VIRTUAL_FAIL");
  if (!ok) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("MAIN_VIRTUAL_EXCEPTION", e?.message ?? String(e));
  process.exit(1);
});
