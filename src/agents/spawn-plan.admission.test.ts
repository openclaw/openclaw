import { assert, expect, it } from "vitest";
import {
  reserveChildAdmissionSlot,
  resolveChildAdmission,
  type ChildAdmissionCap,
} from "./child-admission.js";

type AdmissionParams = Parameters<typeof resolveChildAdmission>[0];
type AnnounceAdmissionParams = Extract<AdmissionParams, { collect: false }>;
type CollectorAdmissionParams = Extract<AdmissionParams, { collect: true }>;
const depthCap = "subagents.maxSpawnDepth";
const liveCap = "tools.swarm.maxChildrenPerGroup";
const totalCap = "tools.swarm.maxTotalPerGroup";
const sessionCap = "subagents.maxChildrenPerAgent";
const sessionFull = { ok: false, governingCap: sessionCap };

const announce = (
  overrides: Partial<Omit<AnnounceAdmissionParams, "collect">> = {},
): AnnounceAdmissionParams => ({
  collect: false,
  callerDepth: 0,
  maxSpawnDepth: 2,
  activeChildren: 0,
  maxActiveChildren: 5,
  ...overrides,
});

const collector = (
  overrides: Partial<Omit<CollectorAdmissionParams, "collect">> = {},
): CollectorAdmissionParams => ({
  ...announce(),
  collect: true,
  maxActiveChildren: 50,
  totalChildren: 0,
  maxTotalChildren: 200,
  ...overrides,
});

const cases: Array<[string, AdmissionParams, ChildAdmissionCap?]> = [
  ["announce below depth", announce({ callerDepth: 1 })],
  ["announce at depth", announce({ callerDepth: 2 }), depthCap],
  ["collector below depth", collector({ callerDepth: 1 })],
  ["collector at depth", collector({ callerDepth: 2 }), depthCap],
  ["announce below session cap", announce({ activeChildren: 4 })],
  ["announce at session cap", announce({ activeChildren: 5 }), sessionCap],
  ["collector below live group cap", collector({ activeChildren: 49 })],
  ["collector at live group cap", collector({ activeChildren: 50 }), liveCap],
  ["collector below lifetime group cap", collector({ totalChildren: 199 })],
  ["collector at lifetime group cap", collector({ totalChildren: 200 }), totalCap],
];

it.each(cases)("decides %s", (_name, params, governingCap) => {
  const result = resolveChildAdmission(params);

  if (!governingCap) {
    expect(result).toEqual({ ok: true });
    return;
  }
  expect(result).toMatchObject({ ok: false, governingCap });
  if (!result.ok) {
    expect(result.error).toContain(governingCap);
  }
});

it("shares pending capacity by controller and releases reservations exactly once", () => {
  let registeredChildren = 0;
  const reserve = (controllerSessionKey = "agent:main:controller") =>
    reserveChildAdmissionSlot({
      controllerSessionKey,
      resolveAdmission: (pendingChildren) =>
        resolveChildAdmission(
          announce({
            activeChildren: registeredChildren + pendingChildren,
            maxActiveChildren: 1,
          }),
        ),
    });
  const first = reserve();
  const otherController = reserve("agent:main:other-controller");
  assert(first.ok && otherController.ok, "Expected independent controller reservations");

  expect(reserve()).toMatchObject(sessionFull);
  first.release();
  first.release();
  otherController.release();

  const replacement = reserve();
  assert(replacement.ok, "Expected released controller capacity");
  registeredChildren += 1;
  replacement.release();
  expect(reserve()).toMatchObject(sessionFull);
});

it("preserves caller-owned fields on both admission outcomes", () => {
  const reserve = (accept: boolean) =>
    reserveChildAdmissionSlot({
      controllerSessionKey: "agent:main:payload-controller",
      resolveAdmission: () =>
        accept
          ? { ok: true as const, maxSpawnDepth: 2 }
          : { ok: false as const, activeChildren: 1 },
    });

  const accepted = reserve(true);
  assert(accepted.ok, "Expected accepted child reservation");
  expect(accepted.maxSpawnDepth).toBe(2);
  accepted.release();

  const rejected = reserve(false);
  if (rejected.ok) {
    rejected.release();
  }
  assert(!rejected.ok, "Expected rejected child reservation");
  expect(rejected.activeChildren).toBe(1);
});
