/** Bedrock control-plane SDK loading and deadline-bound command dispatch. */
import type {
  GetInferenceProfileCommandInput,
  ListInferenceProfilesCommandInput,
} from "@aws-sdk/client-bedrock";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { bedrockCredentialDefaultProvider } from "./aws-credential-refresh.js";

const BEDROCK_CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

export type BedrockControlPlaneSdk = Awaited<ReturnType<typeof loadBedrockControlPlaneSdk>>;

export async function loadBedrockControlPlaneSdk() {
  const {
    BedrockClient,
    GetInferenceProfileCommand,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
  } = await import("@aws-sdk/client-bedrock");
  return {
    createClient: (region?: string) =>
      new BedrockClient({
        ...(region ? { region } : {}),
        credentialDefaultProvider: bedrockCredentialDefaultProvider,
      }),
    createGetInferenceProfileCommand: (input: GetInferenceProfileCommandInput) =>
      new GetInferenceProfileCommand(input),
    createListFoundationModelsCommand: () => new ListFoundationModelsCommand({}),
    createListInferenceProfilesCommand: (input: ListInferenceProfilesCommandInput) =>
      new ListInferenceProfilesCommand(input),
  };
}

export async function runBedrockControlPlaneRequest<T>(params: {
  operation: string;
  signal?: AbortSignal;
  send: (options: { abortSignal?: AbortSignal }) => Promise<T>;
}): Promise<T> {
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: BEDROCK_CONTROL_PLANE_REQUEST_TIMEOUT_MS,
    signal: params.signal,
    operation: params.operation,
  });
  try {
    signal?.throwIfAborted();
    const response = await params.send({ abortSignal: signal });
    signal?.throwIfAborted();
    return response;
  } finally {
    cleanup();
  }
}
