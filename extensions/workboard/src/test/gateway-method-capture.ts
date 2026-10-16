import { vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";

export function createGatewayMethodCapture() {
  type RegisteredMethod = {
    handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
    opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
  };
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    runtime: {
      state: {
        openKeyedStore: vi.fn(),
      },
    },
    registerGatewayMethod: vi.fn(
      (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
        methods.set(method, { handler, opts });
      },
    ),
  } as unknown as OpenClawPluginApi;
  const invoke = async (name: string, params: Record<string, unknown>) => {
    const method = methods.get(name);
    if (!method) {
      throw new Error(`Missing Gateway method: ${name}`);
    }
    const respond = vi.fn();
    await method.handler({ params, respond } as never);
    return respond;
  };
  return { api, methods, invoke, registerGatewayMethod: api.registerGatewayMethod };
}
