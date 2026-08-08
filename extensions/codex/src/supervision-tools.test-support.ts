// Shared request/tool builders for supervision-tools tests.
import { createCodexSupervisionTools } from "./supervision-tools.js";

type CodexSupervisionToolsOptions = Parameters<typeof createCodexSupervisionTools>[0];
type EndpointRequest = NonNullable<CodexSupervisionToolsOptions["request"]>;
type EndpointRequestHandler = (...args: Parameters<EndpointRequest>) => unknown;
type RecordedRequest = { method: string; params?: unknown };

export function createEndpointRequest(handler: EndpointRequestHandler): EndpointRequest {
  return async <T>(...args: Parameters<EndpointRequest>) => (await handler(...args)) as T;
}

export function toolByName(tools: ReturnType<typeof createCodexSupervisionTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

export function createRequest(thread: Record<string, unknown>) {
  const calls: RecordedRequest[] = [];
  const request = createEndpointRequest(async (_endpoint, method, params) => {
    calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "thread/read") {
      return { thread };
    }
    if (method === "thread/loaded/list") {
      return { data: [], nextCursor: null };
    }
    return {};
  });
  return { calls, request };
}

export function createTools(
  request: EndpointRequest,
  overrides: Partial<CodexSupervisionToolsOptions> = {},
) {
  return createCodexSupervisionTools({
    getPluginConfig: () => ({
      supervision: {
        enabled: true,
        allowRawTranscripts: true,
        allowWriteControls: true,
      },
    }),
    senderIsOwner: true,
    request,
    ...overrides,
  });
}
