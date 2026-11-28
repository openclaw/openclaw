import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";

export function createStreamDeps() {
  const streamAnthropicMock = vi.fn(
    (..._args: Parameters<AnthropicVertexStreamDeps["streamAnthropic"]>) =>
      createAssistantMessageEventStream(),
  );
  const anthropicVertexCtorMock = vi.fn();
  const MockAnthropicVertex = function MockAnthropicVertex(options: unknown) {
    anthropicVertexCtorMock(options);
  } as unknown as AnthropicVertexStreamDeps["AnthropicVertex"];
  const googleAuthCtorMock = vi.fn();
  const googleAuthClient = {} as InstanceType<AnthropicVertexStreamDeps["GoogleAuth"]>;
  const MockGoogleAuth = function MockGoogleAuth(options: unknown) {
    googleAuthCtorMock(options);
    return googleAuthClient;
  } as unknown as AnthropicVertexStreamDeps["GoogleAuth"];

  return {
    deps: {
      AnthropicVertex: MockAnthropicVertex,
      GoogleAuth: MockGoogleAuth,
      streamAnthropic: streamAnthropicMock,
    },
    streamAnthropicMock,
    anthropicVertexCtorMock,
    googleAuthCtorMock,
    googleAuthClient,
  };
}
