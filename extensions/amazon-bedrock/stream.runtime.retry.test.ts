import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { bedrockModel, userContext } from "./bedrock.test-support.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

afterEach(() => vi.unstubAllEnvs());

it.for([
  { status: 429, type: "ThrottlingException", message: "Throttling error: fixture failure" },
  {
    status: 500,
    type: "InternalServerException",
    message: "Internal server error: fixture failure",
  },
  { status: 400, type: "ValidationException", message: "Validation error: fixture failure" },
])("returns $type to the retry owner after one physical request", async (error, { signal }) => {
  vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
  vi.stubEnv("AWS_BEDROCK_FORCE_HTTP1", "1");
  vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
  let requests = 0;
  await withServer(
    (request, response) => {
      request.resume();
      requests += 1;
      response.writeHead(error.status, {
        "content-type": "application/json",
        "x-amzn-errortype": error.type,
      });
      response.end(JSON.stringify({ message: "fixture failure" }));
    },
    async (baseUrl) => {
      const result = await streamSimpleBedrock(bedrockModel({ baseUrl }), userContext(), {
        signal,
      }).result();
      expect(result).toMatchObject({ stopReason: "error", errorMessage: error.message });
      expect(requests).toBe(1);
    },
  );
});
