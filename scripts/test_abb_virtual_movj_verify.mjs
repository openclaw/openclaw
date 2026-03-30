import plugin from "../extensions/abb-robot-virtual-control/index.js";

let tool;
plugin.register(
  {
    registerTool: (t) => {
      tool = t;
    },
  },
  { wsBridgePort: 9877, defaultRobot: "abb-crb-15000" },
);

function jointsOf(result) {
  return Array.isArray(result?.details?.joints) ? result.details.joints : [];
}

async function run() {
  const connect = await tool.execute("1", {
    action: "connect",
    port: 9877,
    robot_id: "abb-crb-15000",
  });

  const before = await tool.execute("2", { action: "get_joints" });

  const movj = await tool.execute("3", {
    action: "movj",
    joints: [5, 0, 0, 0, 0, 0],
    speed: 20,
  });

  const after = await tool.execute("4", { action: "get_joints" });

  const beforeJ = jointsOf(before);
  const afterJ = jointsOf(after);

  console.log("VIRTUAL_MOVJ_CONNECT", JSON.stringify(connect?.details ?? {}));
  console.log("VIRTUAL_MOVJ_BEFORE", JSON.stringify(beforeJ));
  console.log("VIRTUAL_MOVJ_RESULT", JSON.stringify(movj?.details ?? {}));
  console.log("VIRTUAL_MOVJ_AFTER", JSON.stringify(afterJ));

  if (
    connect?.details?.connected === true &&
    movj?.details?.success === true &&
    afterJ.length === 6
  ) {
    console.log("VIRTUAL_MOVJ_OK");
  } else {
    console.log("VIRTUAL_MOVJ_FAIL");
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("VIRTUAL_MOVJ_FAIL_EXCEPTION", err?.message ?? String(err));
  process.exit(1);
});
