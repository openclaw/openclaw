import { afterEach, describe, expect, it, vi } from "vitest";
import {
  denyAllPermissionHandler,
  getSdkClient,
  __resetSdkClientForTests,
  type SdkModule,
} from "./sdk-client.js";

function buildFakeSdk(): {
  module: SdkModule;
  listModels: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  sessionSendAndWait: ReturnType<typeof vi.fn>;
  sessionDispose: ReturnType<typeof vi.fn>;
} {
  const sessionSendAndWait = vi.fn(async ({ prompt }: { prompt: string }) => ({
    content: `sdk-reply:${prompt}`,
  }));
  const sessionDispose = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => ({
    sendAndWait: sessionSendAndWait,
    dispose: sessionDispose,
  }));
  const listModels = vi.fn(async () => [{ id: "gpt-5", name: "GPT-5" }]);

  const module: SdkModule = {
    CopilotClient: class {
      start = vi.fn(async () => undefined);
      listModels = listModels;
      createSession = createSession;
      dispose = vi.fn(async () => undefined);
    } as unknown as SdkModule["CopilotClient"],
  };

  return { module, listModels, createSession, sessionSendAndWait, sessionDispose };
}

describe("sdk-client wrapper", () => {
  afterEach(() => {
    __resetSdkClientForTests();
  });

  it("denyAllPermissionHandler returns denied-by-rules", () => {
    expect(denyAllPermissionHandler()).toEqual({ kind: "denied-by-rules", rules: [] });
  });

  it("forwards listModels from the underlying SDK", async () => {
    const fake = buildFakeSdk();
    const client = await getSdkClient({ sdkFactory: async () => fake.module });
    expect(await client.listModels()).toEqual([{ id: "gpt-5", name: "GPT-5" }]);
    expect(fake.listModels).toHaveBeenCalledOnce();
  });

  it("wires runPrompt through a session and disposes the session after use", async () => {
    const fake = buildFakeSdk();
    const client = await getSdkClient({ sdkFactory: async () => fake.module });

    const result = await client.runPrompt({ model: "gpt-5", prompt: "hello" });
    expect(result.content).toBe("sdk-reply:hello");
    expect(fake.createSession).toHaveBeenCalledOnce();
    const createArg = fake.createSession.mock.calls[0][0];
    expect(createArg.model).toBe("gpt-5");
    expect(createArg.onPermissionRequest()).toEqual({ kind: "denied-by-rules", rules: [] });
    expect(fake.sessionDispose).toHaveBeenCalledOnce();
  });

  it("reuses the cached client when options are unchanged", async () => {
    const fake = buildFakeSdk();
    const factory = vi.fn(async () => fake.module);
    const a = await getSdkClient({ sdkFactory: factory });
    const b = await getSdkClient({ sdkFactory: factory });
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("rebuilds the client when cliPath changes", async () => {
    const first = buildFakeSdk();
    const second = buildFakeSdk();
    const factoryFirst = vi.fn(async () => first.module);
    const factorySecond = vi.fn(async () => second.module);

    const a = await getSdkClient({ cliPath: "/a", sdkFactory: factoryFirst });
    const b = await getSdkClient({ cliPath: "/b", sdkFactory: factorySecond });
    expect(a).not.toBe(b);
    expect(factoryFirst).toHaveBeenCalledOnce();
    expect(factorySecond).toHaveBeenCalledOnce();
  });

  it("disposes sessions even when sendAndWait throws", async () => {
    const fake = buildFakeSdk();
    fake.sessionSendAndWait.mockImplementationOnce(async () => {
      throw new Error("session boom");
    });
    const client = await getSdkClient({ sdkFactory: async () => fake.module });
    await expect(client.runPrompt({ model: "gpt-5", prompt: "x" })).rejects.toThrow("session boom");
    expect(fake.sessionDispose).toHaveBeenCalledOnce();
  });
});
