import { expect, it } from "vitest";
import {
  captureRequesterOrigin,
  decodeRequesterOrigin,
  requesterCreatorProfileId,
  resolveRequesterPrincipalKey,
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
