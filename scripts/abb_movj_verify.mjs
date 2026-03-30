import plugin from "../extensions/abb-robot-control/index.js";

let tool = null;
plugin.register(
  {
    registerTool: (t) => {
      tool = t;
    },
  },
  {
    defaultMode: "real",
    controllerHost: "127.0.0.1",
    controllerPort: 7000,
    defaultRobot: "abb-irb-120",
  },
);

function jointsFrom(r) {
  return r?.details?.joints ?? r?.details?.result?.joints ?? [];
}

function parseEndJoints(text) {
  const m = String(text ?? "").match(/End:\[([^\]]+)\]/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));
}

const main = async () => {
  await tool.execute("1", {
    action: "connect",
    mode: "real",
    host: "127.0.0.1",
    port: 7000,
    robot_profile: "abb-irb-120",
  });
  const before = await tool.execute("2", { action: "get_joints", mode: "real" });
  const j0 = jointsFrom(before);
  if (!Array.isArray(j0) || j0.length < 6) {
    console.log("VERIFY_MOVJ_FAIL no_joints");
    return;
  }

  const target = [...j0];
  target[0] = Math.max(-165, Math.min(165, Number(j0[0]) + 0.8));

  const move = await tool.execute("3", {
    action: "movj",
    mode: "real",
    safety_confirmed: true,
    joints: target,
    speed: 8,
    zone: "fine",
  });

  const after = await tool.execute("4", { action: "get_joints", mode: "real" });
  const j1 = jointsFrom(after);
  const d0 = Math.abs(Number(j1[0] ?? 0) - Number(j0[0] ?? 0));
  const moveText = String(move?.content?.[0]?.text ?? "");
  const endJoints = parseEndJoints(moveText);
  const md0 = Math.abs(Number(endJoints[0] ?? j0[0] ?? 0) - Number(j0[0] ?? 0));
  const ok = /executed|movej/i.test(moveText) && (d0 > 0.1 || md0 > 0.1);

  if (ok) {
    console.log(`VERIFY_MOVJ_OK d0=${d0.toFixed(3)} md0=${md0.toFixed(3)}`);
  } else {
    console.log(
      `VERIFY_MOVJ_FAIL d0=${d0.toFixed(3)} md0=${md0.toFixed(3)} msg=${moveText.replace(/\s+/g, " ")}`,
    );
  }
};

main().catch((e) => {
  console.log("VERIFY_MOVJ_FAIL_EXCEPTION", e?.message ?? String(e));
});
