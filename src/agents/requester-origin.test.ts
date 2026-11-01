import { expect, it } from "vitest";
import {
  captureRequesterOrigin,
  decodeRequesterOrigin,
  requesterCreatorProfileId,
  resolveRequesterPrincipalKey,
  carryScheduledRunStamp,
  stampScheduledRunOrigin,
} from "./requester-origin.js";

it.each(["causal-human", null, undefined])(
  "round trips causal attribution without changing selected-user authority (%s)",
  (causal) => {
    const origin = captureRequesterOrigin({
      sessionKey: "agent:main:child",
      operatorProfileId: "selected-user",
      delegatedCreatorProfileId: causal,
    });
    const serialized = JSON.stringify(origin);
    const reopened = decodeRequesterOrigin(JSON.parse(serialized));
    expect(reopened).toEqual(origin);
    expect(requesterCreatorProfileId(reopened)).toBe(
      causal === undefined ? "selected-user" : (causal ?? undefined),
    );
    expect(resolveRequesterPrincipalKey({ requesterOrigin: reopened })).toBe(
      JSON.stringify(["operator", "selected-user"]),
    );
  },
);
it("rejects malformed causal attribution rather than inventing a human", () => {
  expect(
    decodeRequesterOrigin({
      sessionKey: "agent:main:child",
      operatorProfileId: "selected-user",
      delegatedCreatorProfileId: 7,
    }),
  ).toBeUndefined();
  expect(
    requesterCreatorProfileId(captureRequesterOrigin({ sessionKey: "agent:main:system" })),
  ).toBeUndefined();
});

it("carries a scheduled run's stamp only from a captured origin, never from flat input", () => {
  const run = "agent:main:cron:job:run:r1";
  const marked = {
    inheritedToolPolicySource: "scheduled-run",
    inheritedToolPolicyRunSessionKey: run,
  };
  const bare = captureRequesterOrigin({ sessionKey: run });
  const stamped = stampScheduledRunOrigin(bare, marked);
  expect(stamped?.scheduledRunSessionKey).toBe(run);
  expect(captureRequesterOrigin({ requesterOrigin: stamped })).toEqual(stamped);
  expect(decodeRequesterOrigin(structuredClone(stamped))).toEqual(stamped);
  for (const scheduledRunSessionKey of [7, null]) {
    expect(decodeRequesterOrigin({ sessionKey: run, scheduledRunSessionKey })).toBeUndefined();
  }
  const flat = { sessionKey: run, scheduledRunSessionKey: run };
  expect(captureRequesterOrigin(flat as Parameters<typeof captureRequesterOrigin>[0])).toEqual(
    bare,
  );
  for (const policy of [
    { ...marked, delegated: true },
    { inheritedToolPolicySource: "sender" },
    {},
  ]) {
    expect(stampScheduledRunOrigin(bare, policy)).toEqual(bare);
  }
});

it("carries a nested same-session run stamp onto its owner's origin, never inventing one", () => {
  const run = "agent:main:cron:job:run:r1";
  const owner = captureRequesterOrigin({ sessionKey: run });
  const stamped = { sessionKey: run, scheduledRunSessionKey: run };
  expect(carryScheduledRunStamp(owner, stamped)).toEqual(stamped);
  expect(
    carryScheduledRunStamp(owner, { sessionKey: "agent:main:main", scheduledRunSessionKey: run }),
  ).toBe(owner);
  expect(carryScheduledRunStamp(owner, { sessionKey: run })).toBe(owner);
  expect(carryScheduledRunStamp(undefined, stamped)).toBeUndefined();
  const other = { ...stamped, scheduledRunSessionKey: "agent:main:cron:job:run:r2" };
  expect(carryScheduledRunStamp(other, stamped)).toBe(other);
});
