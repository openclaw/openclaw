/** Bedrock control-plane SDK loading and deadline-bound command dispatch. */
import type { BedrockClient } from "@aws-sdk/client-bedrock";

const BEDROCK_DISCOVERY_REQUEST_TIMEOUT_MS = 30_000;

export type BedrockDiscoverySdk = {
  createClient(region: string): BedrockClient;
  createListFoundationModelsCommand(): unknown;
  createListInferenceProfilesCommand(input: { nextToken?: string }): unknown;
};

export async function loadBedrockDiscoverySdk(): Promise<BedrockDiscoverySdk> {
  const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } =
    await import("@aws-sdk/client-bedrock");
  return {
    createClient: (region) => new BedrockClient({ region }),
    createListFoundationModelsCommand: () => new ListFoundationModelsCommand({}),
    createListInferenceProfilesCommand: (input) => new ListInferenceProfilesCommand(input),
  };
}

export function createInjectedClientDiscoverySdk(): BedrockDiscoverySdk {
  class ListFoundationModelsCommand {
    constructor(readonly input: Record<string, unknown> = {}) {}
  }
  class ListInferenceProfilesCommand {
    constructor(readonly input: Record<string, unknown> = {}) {}
  }
  return {
    createClient() {
      throw new Error("clientFactory is required for injected Bedrock discovery commands");
    },
    createListFoundationModelsCommand: () => new ListFoundationModelsCommand({}),
    createListInferenceProfilesCommand: (input) => new ListInferenceProfilesCommand(input),
  };
}

function createBedrockDiscoveryTimeoutError(operation: string): Error {
  const error = new Error(`${operation} timed out after ${BEDROCK_DISCOVERY_REQUEST_TIMEOUT_MS}ms`);
  error.name = "TimeoutError";
  return error;
}

export async function sendBedrockDiscoveryCommand<T>(
  client: BedrockClient,
  command: unknown,
  operation: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(createBedrockDiscoveryTimeoutError(operation));
  }, BEDROCK_DISCOVERY_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return (await client.send(command as never, { abortSignal: controller.signal })) as T;
  } finally {
    clearTimeout(timeout);
  }
}
