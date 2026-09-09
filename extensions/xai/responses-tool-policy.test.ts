import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { requestXaiCodeExecution } from "./src/code-execution-shared.js";
import { requestXaiWebSearch } from "./src/web-search-shared.js";
import { requestXaiXSearch } from "./src/x-search-shared.js";

afterEach(() => vi.unstubAllGlobals());

const connection = { apiKey: "synthetic-tool-fixture", timeoutSeconds: 5 };
const callers = [
  {
    name: "web_search",
    grok43Effort: "low",
    run: (model: string) =>
      requestXaiWebSearch({
        ...connection,
        model,
        query: "fixture",
        endpoint: "https://api.x.ai/v1/responses",
        inlineCitations: false,
      }),
  },
  {
    name: "x_search",
    grok43Effort: "none",
    run: (model: string) =>
      requestXaiXSearch({
        ...connection,
        model,
        options: { query: "fixture" },
        endpoint: "https://api.x.ai/v1/responses",
        inlineCitations: false,
      }),
  },
  {
    name: "code_execution",
    grok43Effort: "low",
    run: (model: string) => requestXaiCodeExecution({ ...connection, model, task: "fixture" }),
  },
];

it.each(callers)(
  "keeps the $name default request within supported reasoning efforts",
  async ({ run }) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ output_text: "fixture result" }),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(request));
    await run("grok-4.6");
    expect(request).toHaveBeenCalledOnce();
    const init = request.mock.calls[0]?.[1];
    expect(init).toEqual(expect.objectContaining({ body: expect.any(String) }));
    const body = new Request("https://api.x.ai/v1/responses", init);
    expect(await body.json()).toMatchObject({
      model: "grok-4.6",
      store: false,
      reasoning: { effort: "low" },
    });
  },
);

it.each(callers)("preserves an explicit model and omitted effort for $name", async ({ run }) => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ output_text: "fixture result" }));
  vi.stubGlobal("fetch", withFetchPreconnect(request));
  await run("grok-4.5");
  const init = request.mock.calls[0]?.[1];
  expect(init).toEqual(expect.objectContaining({ body: expect.any(String) }));
  const body = await new Request("https://api.x.ai/v1/responses", init).json();
  expect(body.model).toBe("grok-4.5");
  expect(body.reasoning).toBeUndefined();
});

it.each(callers)("preserves explicit Grok 4.3 effort for $name", async ({ run, grok43Effort }) => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ output_text: "fixture result" }));
  vi.stubGlobal("fetch", withFetchPreconnect(request));
  await run("grok-4.3");
  const body = await new Request(
    "https://api.x.ai/v1/responses",
    request.mock.calls[0]?.[1],
  ).json();
  expect(body).toMatchObject({ model: "grok-4.3", reasoning: { effort: grok43Effort } });
});
