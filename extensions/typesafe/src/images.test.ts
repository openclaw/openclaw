import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  mixedFixture,
  mockJsonResponse,
  registeredPreparedDecisionProvider,
} from "./transport.test-support.js";

const { lookup, randomUUID } = vi.hoisted(() => ({
  lookup: vi.fn<LookupFn>(),
  randomUUID: vi.fn<typeof import("node:crypto").randomUUID>(),
}));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID,
}));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

const imageHeader = "TypeSafe-Danger-Zone-Images";
const hostedUrl = "https://api.typesafe.ai/v1";
const image = (dataUri = "data:image/png;base64,AA==", text?: string): DecisionBatchV2 => ({
  state: { type: "image", dataUri, ...(text === undefined ? {} : { text }) },
  questions: mixedFixture.batch.questions,
});
const context = (baseUrl = hostedUrl): DecisionProviderContextV2 => ({
  model: { provider: "typesafe", id: "jev-latest", name: "Jev", baseUrl },
  config: {},
  auth: { mode: "api-key", apiKey: "synthetic-prepared-key" },
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 2000,
  isAdmissible: () => true,
});
type ModelProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

function provider(overrides: Partial<ModelProviderConfig> = {}) {
  const config = {
    models: {
      providers: {
        typesafe: { baseUrl: hostedUrl, apiKey: "synthetic-config-key", models: [], ...overrides },
      },
    },
  };
  return registeredPreparedDecisionProvider(() => config);
}
function sent(fetch: ReturnType<typeof mockJsonResponse>) {
  const init = fetch.mock.lastCall?.[1];
  if (typeof init?.body !== "string") {
    throw new Error("Expected a serialized TypeSafe request");
  }
  return { body: JSON.parse(init.body), headers: new Headers(init.headers) };
}
beforeAll(async () => {
  await import("./client.js");
});
beforeEach(() => {
  randomUUID.mockReset().mockReturnValue("00000000-0000-4000-8000-000000000001");
  lookup.mockReset().mockResolvedValue([{ address: "104.18.0.1", family: 4 }]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  ["png", "data:image/png;base64,AA==", "Synthetic caption"],
  ["png", "data:image/png;base64,AA==", ""],
  ["jpg", "data:image/jpeg;base64,/9j/", undefined],
])(
  "sends a referenced %s image through the registered prepared executor",
  async (format, dataUri, text) => {
    const fetch = mockJsonResponse(mixedFixture.response);
    const prepared = context();
    prepared.model.headers = { "x-prepared": "model-header", [imageHeader]: "false" };
    const outcome = await provider({
      // The prepared route and credential must win, not the original config snapshot.
      baseUrl: "https://original.fixture.invalid/v1",
      headers: { "x-original": "must-not-leak" },
      request: { headers: { [imageHeader.toLowerCase()]: "false" } },
    }).evaluate(image(dataUri, text), prepared);
    expect(outcome).toEqual(mixedFixture.result);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.lastCall?.[0]).toBe(`${hostedUrl}/systemone`);
    const { body, headers } = sent(fetch);
    expect(headers.get("authorization")).toBe("Bearer synthetic-prepared-key");
    expect(headers.get("x-prepared")).toBe("model-header");
    expect(headers.has("x-original")).toBe(false);
    expect(headers.get(imageHeader)).toBe("true");
    const ref = Object.keys(body.assets)[0] ?? "";
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toEqual({
      state: text === undefined ? ref : [text, ref],
      questions: mixedFixture.input.questions,
      model: "jev-latest",
      assets: { [ref]: { type: "image", format, data_base64: dataUri.split(",")[1] } },
    });
  },
);

it("keeps a caller's UUID text separate from its image reference", async () => {
  const caption = "00000000-0000-4000-8000-000000000000";
  randomUUID.mockReturnValueOnce(caption);
  const fetch = mockJsonResponse(mixedFixture.response);
  await expect(provider().evaluate(image(undefined, caption), context())).resolves.toEqual(
    mixedFixture.result,
  );
  const { body } = sent(fetch);
  expect(body.state).toEqual([caption, "00000000-0000-4000-8000-000000000001"]);
  expect(body.assets).toEqual({
    "00000000-0000-4000-8000-000000000001": {
      type: "image",
      format: "png",
      data_base64: "AA==",
    },
  });
  expect(randomUUID).toHaveBeenCalledTimes(2);
});

it("keeps text wire behavior and removes the image opt-in from text requests", async () => {
  const fetch = mockJsonResponse(mixedFixture.response);
  const outcome = await provider({ request: { headers: { [imageHeader]: "true" } } }).evaluate(
    {
      state: mixedFixture.batch.state,
      questions: mixedFixture.batch.questions,
    },
    context(),
  );
  expect(outcome).toEqual(mixedFixture.result);
  const { body, headers } = sent(fetch);
  expect(body).toEqual({ ...mixedFixture.input, model: "jev-latest" });
  expect(headers.has(imageHeader)).toBe(false);
});

it.each([
  ["https://custom.fixture.invalid/v1", "jev-latest"],
  ["https://api.typesafe.ai/custom/v1", "jev-latest"],
  ["http://127.0.0.1:8009/v1", "kev-latest"],
  [hostedUrl, "kev-latest"],
  [hostedUrl, "unknown-model"],
])("rejects images on unsupported prepared route %s/%s before egress", async (baseUrl, id) => {
  const fetch = mockJsonResponse(mixedFixture.response);
  const prepared = context(baseUrl);
  prepared.model.id = id;
  await expect(provider().evaluate(image(), prepared)).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
});

it.each([
  { ...image(), state: { type: "image", dataUri: "data:image/webp;base64,AA==" } },
  { ...image(), questions: { q: { type: "box", instructions: "Locate the object" } } },
  { ...image(), questions: { q: { type: "tags", criteria: { red: "Red" } } } },
  ...["explicit JSON string", 5, true].map((value) => ({
    state: { type: "json" as const, value },
    questions: mixedFixture.batch.questions,
  })),
  {
    state: { type: "text", text: "synthetic" },
    questions: Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [String(index), { type: "boolean" as const }]),
    ),
  },
] satisfies DecisionBatchV2[])(
  "rejects unsupported prepared contracts before dispatch",
  async (batch) => {
    const fetch = mockJsonResponse(mixedFixture.response);
    await expect(provider().evaluate(batch, context())).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("admits the host's 4 MiB image bound without applying the text-only wire limit", async () => {
  const fetch = mockJsonResponse(mixedFixture.response);
  const data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
  await expect(
    provider().evaluate(image(`data:image/png;base64,${data}`), context()),
  ).resolves.toEqual(mixedFixture.result);
  const { body } = sent(fetch);
  expect(Object.values(body.assets)).toEqual([{ type: "image", format: "png", data_base64: data }]);
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
  await expect(
    provider().evaluate(image(`data:image/png;base64,${oversized}`), context()),
  ).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).toHaveBeenCalledOnce();
});
