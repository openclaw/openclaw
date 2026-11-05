import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";

const provider = await registerSingleProviderPlugin(plugin);

async function fetchVeniceUsage(response: Response | typeof fetch) {
  const snapshot = await provider.fetchUsageSnapshot?.({
    config: {},
    env: {},
    provider: "venice",
    token: "venice-key",
    timeoutMs: 5000,
    fetchFn: typeof response === "function" ? response : async () => response,
  });
  if (!snapshot) {
    throw new Error("Venice usage provider returned no snapshot");
  }
  return snapshot;
}

it("maps balances and DIEM epoch allocation", async () => {
  const snapshot = await fetchVeniceUsage(async (url, init) => {
    expect(url).toBe("https://api.venice.ai/api/v1/billing/balance");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer venice-key",
    });
    return Response.json({
      canConsume: true,
      consumptionCurrency: "diem",
      balances: { diem: "75", usd: 8.5 },
      diemEpochAllocation: "100",
    });
  });

  expect(snapshot).toEqual({
    provider: "venice",
    displayName: "Venice",
    windows: [{ label: "DIEM epoch", usedPercent: 25 }],
    billing: [
      { type: "balance", label: "DIEM balance", amount: 75, unit: "DIEM" },
      { type: "balance", label: "USD balance", amount: 8.5, unit: "USD" },
      {
        type: "budget",
        label: "DIEM epoch",
        used: 25,
        limit: 100,
        unit: "DIEM",
        period: "epoch",
      },
    ],
    plan: "DIEM billing",
  });
});

it("preserves unavailable status with balances", async () => {
  const snapshot = await fetchVeniceUsage(
    Response.json({ canConsume: false, balances: { usd: 0 } }),
  );

  expect(snapshot.summary).toBe("API consumption unavailable");
  expect(snapshot.billing).toEqual([
    { type: "balance", label: "USD balance", amount: 0, unit: "USD" },
  ]);
});

it("returns HTTP status without exposing provider error bodies", async () => {
  const snapshot = await fetchVeniceUsage(new Response("private", { status: 403 }));

  expect(snapshot.error).toBe("HTTP 403");
});

it.each([
  { response: () => Response.json(null), error: "Malformed usage response" },
  {
    response: () => {
      throw new Error("network down");
    },
    error: "Usage unavailable",
  },
])("returns $error with no windows", async ({ response, error }) => {
  expect(await fetchVeniceUsage(async () => response())).toMatchObject({ error, windows: [] });
});
