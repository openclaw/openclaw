import { ownCodexInferenceClient, prepareCodexInferenceThreadConfig } from "./inference-routing.js";
import { createClientHarness } from "./test-support.js";

export { stubCodexInferenceTransportEnv } from "./test-support.js";

export function createCodexSubscriptionRoutingTestFixture() {
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line);
      if (request.method !== "account/read") {
        throw new Error(`Unexpected native request: ${request.method}`);
      }
      send({ id: request.id, result: { account: { type: "apiKey" } } });
    },
  });
  return {
    writes: harness.writes,
    close: () => harness.client.close(),
    async prepare() {
      ownCodexInferenceClient(
        harness.client,
        {},
        {
          resolve: async () => ({ token: "synthetic-subscription-token", assertCurrent() {} }),
        },
      );
      const prepared = await prepareCodexInferenceThreadConfig({
        client: harness.client,
        binding: undefined,
        clientId: "fixture-native-client",
        cwd: "/workspace",
        assertCurrent() {},
        effectiveConfig: { config: {}, origins: {} },
      });
      if (!prepared) {
        throw new Error("Subscription relay was not prepared");
      }
      return prepared;
    },
  };
}
