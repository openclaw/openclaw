import { assert, expect, it } from "vitest";
import {
  reserveChildAdmissionSlot,
  resolveChildAdmission,
  type ChildAdmissionCap,
} from "./child-admission.js";

type AdmissionParams = Parameters<typeof resolveChildAdmission>[0];
const announce = {
  collect: false,
  callerDepth: 1,
  maxSpawnDepth: 2,
  activeChildren: 4,
  maxActiveChildren: 5,
} as const satisfies AdmissionParams;
const collector = {
  ...announce,
  collect: true,
  activeChildren: 49,
  maxActiveChildren: 50,
  totalChildren: 199,
  maxTotalChildren: 200,
} as const satisfies AdmissionParams;
const sessionFull = { ok: false, governingCap: "subagents.maxChildrenPerAgent" };

it.each<[string, AdmissionParams, ChildAdmissionCap?]>([
  ["announce below all caps", announce],
  ["collector below all caps", collector],
  ["depth", { ...announce, callerDepth: 2 }, "subagents.maxSpawnDepth"],
  ["session", { ...announce, activeChildren: 5 }, "subagents.maxChildrenPerAgent"],
  ["live group", { ...collector, activeChildren: 50 }, "tools.swarm.maxChildrenPerGroup"],
  ["lifetime group", { ...collector, totalChildren: 200 }, "tools.swarm.maxTotalPerGroup"],
])("decides admission at %s", (_name, params, governingCap) => {
  const result = resolveChildAdmission(params);
  if (!governingCap) {
    expect(result).toEqual({ ok: true });
  } else {
    expect(result).toMatchObject({
      ok: false,
      governingCap,
      error: expect.stringContaining(governingCap),
    });
  }
});

it("shares capacity by controller, preserves caller fields, and releases exactly once", () => {
  let registeredChildren = 0;
  const reserve = (controllerSessionKey = "agent:main:controller") =>
    reserveChildAdmissionSlot({
      controllerSessionKey,
      resolveAdmission: (pendingChildren) => ({
        ...resolveChildAdmission({
          ...announce,
          activeChildren: registeredChildren + pendingChildren,
          maxActiveChildren: 1,
        }),
        activeChildren: registeredChildren + pendingChildren,
        maxSpawnDepth: announce.maxSpawnDepth,
      }),
    });
  const first = reserve();
  const otherController = reserve("agent:main:other-controller");
  assert(first.ok && otherController.ok, "Expected independent controller reservations");
  expect(first.maxSpawnDepth).toBe(2);
  expect(reserve()).toMatchObject({ ...sessionFull, activeChildren: 1 });
  first.release();
  first.release();
  otherController.release();
  const replacement = reserve();
  assert(replacement.ok, "Expected released controller capacity");
  registeredChildren += 1;
  replacement.release();
  expect(reserve()).toMatchObject(sessionFull);
});
