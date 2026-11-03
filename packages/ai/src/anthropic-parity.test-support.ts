import { captureAnthropicRequest } from "./provider-transport-parity.test-support.js";

export async function* capturePaths(
  options: Parameters<typeof captureAnthropicRequest>[1] = {},
  transportOnly = false,
) {
  const paths = transportOnly ? (["transport"] as const) : (["provider", "transport"] as const);
  for (const implementation of paths) {
    yield { implementation, ...(await captureAnthropicRequest(implementation, options)) };
  }
}
