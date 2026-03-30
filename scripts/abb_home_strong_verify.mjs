import plugin from "../extensions/abb-robot-control/index.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnd(text) {
  const m = String(text ?? "").match(/End:\[([^\]]+)\]/i);
  if (!m) {
    return [];
  }
  return m[1]
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));
}

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

const conn = await tool.execute("conn", {
  action: "connect",
  mode: "real",
  host: "127.0.0.1",
  port: 7000,
  robot_profile: "abb-irb-120",
});

const j0r = await tool.execute("j0", { action: "get_joints", mode: "real" });
const j0 = j0r?.details?.joints ?? [];

const target = [...(Array.isArray(j0) && j0.length >= 6 ? j0 : [0, 0, 0, 0, 0, 0])];
target[0] = Number(target[0] ?? 0) + 1.2;
target[1] = Number(target[1] ?? 0) - 0.8;

const move = await tool.execute("move", {
  action: "movj",
  mode: "real",
  safety_confirmed: true,
  joints: target,
  speed: 10,
  zone: "fine",
});

const moveText = String(move?.content?.[0]?.text ?? "");
const moveEnd = parseEnd(moveText);

const home = await tool.execute("home", { action: "go_home", mode: "real" });
const homeText = String(home?.content?.[0]?.text ?? "");

let j1 = [];
let nearHome = false;
for (let i = 0; i < 20; i++) {
  const j1r = await tool.execute(`j1-${i}`, { action: "get_joints", mode: "real" });
  j1 = j1r?.details?.joints ?? [];
  if (Array.isArray(j1) && j1.length >= 6) {
    const maxAbs = Math.max(...j1.slice(0, 6).map((v) => Math.abs(Number(v ?? 0))));
    if (maxAbs <= 0.2) {
      nearHome = true;
      break;
    }
  }
  await sleep(400);
}

const okConn = Boolean(conn?.details?.connected);
const okMove = /movej|executed/i.test(moveText) && moveEnd.length >= 6;
const okHome = /home position/i.test(homeText) && nearHome;

console.log(
  JSON.stringify(
    {
      ok: okConn && okMove && okHome,
      connect: conn?.content?.[0]?.text,
      beforeJoints: j0,
      targetJoints: target,
      moveText,
      moveEnd,
      homeText,
      nearHome,
      afterJoints: j1,
    },
    null,
    2,
  ),
);
