import { vi } from "vitest";

export const activeRunRegistrationMocks = {
  cancelPendingAgentQuestionForSession: vi.fn(),
  clearActiveEmbeddedRun: vi.fn(),
  setActiveEmbeddedRun: vi.fn(),
  questionWaiters: new Map<string, (value: unknown) => void>(),
  cancelQuestionError: undefined as Error | undefined,
};

export async function createSteeringRuntimeMock(
  actual: typeof import("openclaw/plugin-sdk/agent-harness-runtime"),
) {
  const gatewayCall = async (...args: Parameters<typeof actual.callGatewayTool>) => {
    const [method, , rawParams] = args;
    const params = rawParams as { id?: string; answers?: unknown; cancel?: boolean } | undefined;
    if (method === "question.request") {
      return { id: params?.id, expiresAtMs: Date.now() + 60_000 };
    }
    if (method === "question.waitAnswer") {
      return await new Promise((resolve) => {
        activeRunRegistrationMocks.questionWaiters.set(params?.id ?? "", resolve);
      });
    }
    if (method === "question.resolve") {
      const result = params?.cancel
        ? { status: "cancelled" as const }
        : { status: "answered" as const, answers: params?.answers };
      activeRunRegistrationMocks.questionWaiters.get(params?.id ?? "")?.(result);
      return result;
    }
    return await actual.callGatewayTool(...args);
  };
  return {
    ...actual,
    cancelPendingAgentQuestionForSession: async (
      ...args: Parameters<typeof actual.cancelPendingAgentQuestionForSession>
    ) => {
      activeRunRegistrationMocks.cancelPendingAgentQuestionForSession(...args);
      const error = activeRunRegistrationMocks.cancelQuestionError;
      activeRunRegistrationMocks.cancelQuestionError = undefined;
      if (error) {
        throw error;
      }
      return await actual.cancelPendingAgentQuestionForSession(...args);
    },
    agentHarnessStructuredInput: {
      ...actual.agentHarnessStructuredInput,
      run: (params: Parameters<typeof actual.agentHarnessStructuredInput.run>[0]) =>
        actual.agentHarnessStructuredInput.run({ ...params, gatewayCall }),
    },
    clearActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.clearActiveEmbeddedRun>
    ): ReturnType<typeof actual.clearActiveEmbeddedRun> => {
      activeRunRegistrationMocks.clearActiveEmbeddedRun(...args);
      return actual.clearActiveEmbeddedRun(...args);
    },
    setActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.setActiveEmbeddedRun>
    ): ReturnType<typeof actual.setActiveEmbeddedRun> => {
      activeRunRegistrationMocks.setActiveEmbeddedRun(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
}
