// Qa Matrix tests prove one differential probe against the Matrix substrate contract.
import { describe, expect, it } from "vitest";
import { runMatrixQaDifferentialProbe } from "./differential-probe.js";

function createProbeFetch(params?: {
  missingStateErrcode?: string;
  userId?: string;
}): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });
    if (url.pathname.endsWith("/versions")) {
      return json({ versions: ["v1.11"] });
    }
    if (url.pathname.endsWith("/account/whoami")) {
      return json({ user_id: params?.userId ?? "@probe:matrix.test" });
    }
    if (url.pathname.endsWith("/sync")) {
      return json({ next_batch: url.searchParams.has("since") ? "sync-2" : "sync-1" });
    }
    return json({ errcode: params?.missingStateErrcode ?? "M_NOT_FOUND" }, 404);
  };
}

describe("Matrix QA differential probe", () => {
  it("runs unchanged against the Matrix substrate contract", async () => {
    const result = await runMatrixQaDifferentialProbe({
      accessToken: "token",
      baseUrl: "http://matrix.test",
      fetchImpl: createProbeFetch(),
      roomId: "!probe:matrix.test",
      userId: "@probe:matrix.test",
    });

    expect(result.profile).toBe("matrix-qa-v1");
    expect(result.sync).toEqual({
      continuity: true,
      incrementalStatus: 200,
      initialStatus: 200,
    });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["versions", 200],
      ["whoami", 200],
      ["sync-initial", 200],
      ["sync-incremental", 200],
      ["missing-state", 404],
    ]);
    expect(result.steps.at(-1)?.errcode).toBe("M_NOT_FOUND");
  });

  it("rejects a mismatched whoami identity", async () => {
    await expect(
      runMatrixQaDifferentialProbe({
        accessToken: "token",
        baseUrl: "http://matrix.test",
        fetchImpl: createProbeFetch({ userId: "@other:matrix.test" }),
        roomId: "!probe:matrix.test",
        userId: "@probe:matrix.test",
      }),
    ).rejects.toThrow("unexpected user_id");
  });

  it("rejects a missing-state response with the wrong Matrix errcode", async () => {
    await expect(
      runMatrixQaDifferentialProbe({
        accessToken: "token",
        baseUrl: "http://matrix.test",
        fetchImpl: createProbeFetch({ missingStateErrcode: "M_FORBIDDEN" }),
        roomId: "!probe:matrix.test",
        userId: "@probe:matrix.test",
      }),
    ).rejects.toThrow("did not return M_NOT_FOUND");
  });
});
