import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeExecutionTool } from "./code-execution.js";
import { xaiPluginConfig } from "./plugin-config.test-support.js";
import { requestXaiWebSearch } from "./src/web-search-shared.js";
import { requestXaiXSearch } from "./src/x-search-shared.js";

afterEach(() => vi.unstubAllGlobals());

const connection = { apiKey: "synthetic-tool-fixture", timeoutSeconds: 5 };
const endpoint = "https://api.x.ai/v1/responses";
const search = { ...connection, endpoint, inlineCitations: false };
const callers = [
  [
    "web_search",
    "low",
    (model: string) => requestXaiWebSearch({ ...search, model, query: "fixture" }),
  ],
  [
    "x_search",
    "none",
    (model: string) => requestXaiXSearch({ ...search, model, options: { query: "fixture" } }),
  ],
  [
    "code_execution",
    "low",
    (model: string) => {
      const config = xaiPluginConfig({
        webSearch: { apiKey: connection.apiKey },
        codeExecution: { model, timeoutSeconds: connection.timeoutSeconds },
      });
      const tool = createCodeExecutionTool({ config, runtimeConfig: config });
      if (!tool) {
        throw new Error("Expected xAI code execution tool");
      }
      return tool.execute("code-execution:policy-fixture", { task: "fixture" });
    },
  ],
] as const;

async function capture(run: (model: string) => Promise<unknown>, model: string) {
  const request = vi.fn<typeof fetch>(async () => Response.json({ output_text: "fixture result" }));
  vi.stubGlobal("fetch", withFetchPreconnect(request));
  await run(model);
  const init = request.mock.calls[0]?.[1];
  return new Request(endpoint, init).json();
}

it.each(
  callers.flatMap(([name, grok43Effort, run]) =>
    [
      { model: "grok-4.7", reasoning: { effort: "low" } },
      { model: "grok-4.5", reasoning: undefined },
      { model: "grok-4.3", reasoning: { effort: grok43Effort } },
    ].map(({ model, reasoning }) => ({ name, run, model, reasoning })),
  ),
)("preserves $name model and reasoning policy for $model", async ({ run, model, reasoning }) => {
  const body = await capture(run, model);
  expect(body).toMatchObject({ model, store: false });
  expect(body.reasoning).toEqual(reasoning);
});
