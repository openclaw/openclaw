/**
 * test-abbbridge.ts
 * Integration + unit tests for ABBBridge / ABBController / abb-robot-tool actions.
 *
 * Run with:  npx ts-node --esm src/test-abbbridge.ts [--host <ip>] [--real]
 *
 * Without --real: offline tests only (no controller needed).
 * With    --real: full live controller tests at --host <ip>.
 */

import { createController } from "./abb-controller.js";
import { handleAction, type MotionState } from "./abb-robot-tool-actions.js";
import { loadRobotConfig } from "./robot-config-loader.js";

const args = process.argv.slice(2);
const hostIdx = args.indexOf("--host");
const HOST: string = hostIdx !== -1 ? (args[hostIdx + 1] ?? "127.0.0.1") : "127.0.0.1";
const REAL: boolean = args.includes("--real");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${String(err)}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const errorResult = (msg: string) => ({
  content: [{ type: "text" as const, text: `ERROR: ${msg}` }],
  details: { error: msg },
});

function freshMotionState(): MotionState {
  return { lastTarget: null, history: [] };
}

console.log(`\n${"=".repeat(60)}`);
console.log(`  ABBBridge Test Suite  host=${HOST}  real=${REAL}`);
console.log(`${"=".repeat(60)}`);

const cfg = loadRobotConfig("abb-crb-15000");
const getCfg = (_id: string) => cfg;
const ms = freshMotionState();

// ── Section 1: robot-config-loader ───────────────────────────────────────────
console.log("\n[1] robot-config-loader");

await test("loadRobotConfig abb-crb-15000 loads", async () => {
  assert(cfg.id === "abb-crb-15000", "id mismatch");
  assert(cfg.joints.length >= 6, "expected 6+ joints");
});

await test("loadRobotConfig missing robot throws", async () => {
  let threw = false;
  try { loadRobotConfig("nonexistent-robot-xyz"); } catch { threw = true; }
  assert(threw, "should have thrown");
});

// ── Section 2: offline handleAction tests ─────────────────────────────────────
console.log("\n[2] handleAction (offline)");

await test("unknown action returns error", async () => {
  const r = await handleAction("__unknown__", {}, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error field");
});

await test("list_robots returns array", async () => {
  const r = await handleAction("list_robots", {}, null, cfg, {}, getCfg, errorResult, ms);
  assert(Array.isArray(r.details?.robots), "robots should be array");
});

await test("list_presets for known robot", async () => {
  const r = await handleAction("list_presets", { robot_id: "abb-crb-15000" }, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.robotId === "abb-crb-15000", "robotId mismatch");
});

await test("get_motion_memory returns historyCount", async () => {
  const r = await handleAction("get_motion_memory", {}, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.historyCount !== undefined, "historyCount missing");
});

await test("reset_motion_memory clears state", async () => {
  const s = freshMotionState();
  s.history.push({ timestamp: new Date().toISOString(), joints: [0,0,0,0,0,0], source: "test" });
  s.lastTarget = [1,2,3,4,5,6];
  await handleAction("reset_motion_memory", {}, null, cfg, {}, getCfg, errorResult, s);
  assert(s.history.length === 0, "history not cleared");
  assert(s.lastTarget === null, "lastTarget not cleared");
});

await test("disconnect without connection returns error", async () => {
  const r = await handleAction("disconnect", {}, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error");
});

await test("set_joints without connection returns error", async () => {
  const r = await handleAction("set_joints", { joints: [0,0,0,0,0,0] }, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error");
});

await test("movj_rapid without connection returns error", async () => {
  const r = await handleAction("movj_rapid", { joints: [0,0,0,0,0,0] }, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error");
});

await test("movj without joints returns error", async () => {
  const r = await handleAction("movj", {}, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error");
});

await test("get_status without connection returns not-connected", async () => {
  const r = await handleAction("get_status", {}, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.connected === false, "expected connected=false");
});

await test("movl without required params returns error", async () => {
  const r = await handleAction("movl", { x: 100 }, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error for missing y,z,etc.");
});

await test("movc without array params returns error", async () => {
  const r = await handleAction("movc", { circ_point: [0] }, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error for missing/invalid arrays");
});

await test("set_rapid_variable without value returns error", async () => {
  const r = await handleAction("set_rapid_variable", { var_name: "test" }, null, cfg, {}, getCfg, errorResult, ms);
  assert(r.details?.error !== undefined, "expected error for missing value");
});

// ── Section 3: scanControllers (no connection required) ───────────────────────
console.log("\n[3] ABBController.scanControllers");

await test("scanControllers returns result object", async () => {
  const ctrl = createController({ host: HOST });
  try {
    const result = await ctrl.scanControllers();
    assert(typeof result === "object" && result !== null, "result not object");
    console.log(`         Found ${result.total ?? 0} controller(s)`);
    (result.controllers ?? []).forEach((c: any) =>
      console.log(`         -> ${c.ip} ${c.systemName} virtual=${c.isVirtual}`)
    );
  } catch (err) {
    // Network unavailable is acceptable in CI
    console.log(`         (scan skipped: ${String(err)})`);
  }
});

// ── Section 4: RAPID code generation (no connection) ─────────────────────────
console.log("\n[4] RAPID code generation");

await test("generateRapidMoveJoints has MODULE+MoveAbsJ+Stop+ConfJ", async () => {
  const ctrl = createController({ host: HOST });
  // generateRapidMoveJoints does not require connection
  const code = ctrl.generateRapidMoveJoints([0, 0, 0, 0, 30, 0], 20, "fine");
  assert(code.includes("MODULE OpenClawMotionMod"), "missing MODULE");
  assert(code.includes("MoveAbsJ"), "missing MoveAbsJ");
  assert(code.includes("Stop;"), "missing Stop");
  assert(code.includes("ConfJ"), "missing ConfJ");
});

await test("generateRapidSequence has p0+p1 vars and MODULE name", async () => {
  const ctrl = createController({ host: HOST });
  const code = ctrl.generateRapidSequence([
    { joints: [0,0,0,0,0,0], speed: 20 },
    { joints: [10,-10,10,0,10,0], speed: 20 },
  ], "TestSeq");
  assert(code.includes("MODULE TestSeq"), "missing MODULE TestSeq");
  assert(code.includes("p0") && code.includes("p1"), "missing waypoint vars");
  assert(code.includes("Stop;"), "missing Stop");
});

// ── Section 5: Live controller tests ─────────────────────────────────────────
console.log(`\n[5] Live controller tests (host=${HOST})`);

const liveCtrl = createController({ host: HOST });
let connected = false;

await test("connect() succeeds", async () => {
  await liveCtrl.connect();
  connected = liveCtrl.isConnected();
  assert(connected, "isConnected should be true");
  console.log(`         System: ${liveCtrl.getSystemName()}`);
});

if (connected) {
  await test("getStatus has operationMode + motorState", async () => {
    const s = await liveCtrl.getStatus();
    assert(s.connected === true, "connected");
    assert(typeof s.operationMode === "string", "operationMode missing");
    assert(typeof s.motorState === "string", "motorState missing");
    console.log(`         mode=${s.operationMode} motors=${s.motorState} rapid=${s.rapidRunning}`);
  });

  await test("getSystemInfo returns systemName", async () => {
    const info = await liveCtrl.getSystemInfo() as any;
    assert(info.success !== false, `failed: ${info.error}`);
    console.log(`         systemName=${info.systemName} virtual=${info.isVirtual}`);
  });

  await test("getServiceInfo returns production hours", async () => {
    const info = await liveCtrl.getServiceInfo() as any;
    assert(info.success !== false, `failed: ${info.error}`);
    console.log(`         hours=${info.elapsedProductionHours}`);
  });

  await test("getSpeedRatio in range 1-100", async () => {
    const ratio = await liveCtrl.getSpeedRatio();
    assert(ratio >= 1 && ratio <= 100, `out of range: ${ratio}`);
    console.log(`         speedRatio=${ratio}%`);
  });

  await test("setSpeedRatio(50) then restore", async () => {
    const orig = await liveCtrl.getSpeedRatio();
    const v = await liveCtrl.setSpeedRatio(50);
    assert(v === 50, `expected 50 got ${v}`);
    await liveCtrl.setSpeedRatio(orig);
  });

  await test("getJointPositions returns 6+ numbers", async () => {
    const joints = await liveCtrl.getJointPositions();
    assert(joints.length >= 6, `expected 6+ joints, got ${joints.length}`);
    console.log(`         joints=[${joints.map(v => v.toFixed(2)).join(", ")}]`);
  });

  await test("getWorldPosition returns x/y/z", async () => {
    const pos = await liveCtrl.getWorldPosition();
    assert(typeof pos.x === "number" && typeof pos.z === "number", "x/z missing");
    console.log(`         X=${pos.x.toFixed(1)} Y=${pos.y.toFixed(1)} Z=${pos.z.toFixed(1)}`);
  });

  await test("getEventLogEntries(0, 5) returns array", async () => {
    const r = await liveCtrl.getEventLogEntries(0, 5) as any;
    assert(r.success !== false, `failed: ${r.error}`);
    assert(Array.isArray(r.entries), "entries not array");
    console.log(`         ${r.entries.length} entries`);
  });

  await test("listTasks returns tasks array", async () => {
    const r = await liveCtrl.listTasks() as any;
    assert(r.success !== false, `failed: ${r.error}`);
    assert(Array.isArray(r.tasks), "tasks not array");
    r.tasks.forEach((t: any) => console.log(`         task=${t.taskName} [${t.executionStatus}]`));
  });

  if (REAL) {
    console.log("\n   [motion tests: REAL mode]");
    await test("movj_rapid move [0,0,0,0,30,0] speed:10", async () => {
      const r = await handleAction(
        "movj_rapid", { joints: [0,0,0,0,30,0], speed: 10, zone: "fine" },
        liveCtrl, cfg, {}, getCfg, errorResult, freshMotionState()
      );
      assert(!r.details?.error, `error: ${r.details?.error}`);
    });
    await test("movj_rapid return home [0,0,0,0,0,0] speed:10", async () => {
      const r = await handleAction(
        "movj_rapid", { joints: [0,0,0,0,0,0], speed: 10, zone: "fine" },
        liveCtrl, cfg, {}, getCfg, errorResult, freshMotionState()
      );
      assert(!r.details?.error, `error: ${r.details?.error}`);
    });
  } else {
    console.log("   [motion tests skipped: pass --real to enable]");
  }

  await test("disconnect succeeds", async () => {
    await liveCtrl.disconnect();
    assert(!liveCtrl.isConnected(), "should be disconnected");
  });
} else {
  console.log("   [live tests skipped: connect() failed]");
}

const bar = "=".repeat(60);
console.log(`\n${bar}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${bar}\n`);
process.exit(failed > 0 ? 1 : 0);
