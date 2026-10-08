import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexNativeHookRemoteCredential } from "./native-hook-relay-remote.js";
import type { JsonObject } from "./protocol.js";

function fixture() {
  const request = vi.fn<CodexAppServerClient["request"]>().mockResolvedValue({});
  const enableRemoteCallback = vi.fn(() => ({ token: "synthetic-relay-capability" }));
  const assertCurrent = vi.fn();
  const params = {
    config: {
      url: "https://gateway.example/node/__openclaw__/native-hook",
      credentialDirectory: "/home/node/.native-hooks",
    },
    client: { request },
    relay: { relayId: "relay-1", generation: "generation-1", enableRemoteCallback },
    timeoutMs: 1_000,
    assertCurrent,
  };
  return {
    ...params,
    request,
    enableRemoteCallback,
    credential: createCodexNativeHookRemoteCredential(params),
  };
}

describe("remote native hook credential projection", () => {
  it("delivers a relay-only capability and removes it once through the captured client", async () => {
    const f = fixture();
    await Promise.all([f.credential.prepare(), f.credential.prepare()]);
    expect(f.enableRemoteCallback).toHaveBeenCalledOnce();
    const write = f.request.mock.calls[0];
    expect(write?.[0]).toBe("fs/writeFile");
    expect(write?.[1]).toMatchObject({ path: f.credential.path });
    const payload = write?.[1] as { dataBase64: string };
    expect(JSON.parse(Buffer.from(payload.dataBase64, "base64").toString())).toEqual({
      url: "https://gateway.example/node/__openclaw__/native-hook/relay-1",
      token: "synthetic-relay-capability",
    });
    expect(f.credential.path).not.toContain("synthetic-relay-capability");
    await Promise.all([f.credential.dispose(), f.credential.dispose()]);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenLastCalledWith(
      "fs/remove",
      {
        path: f.credential.path,
        force: true,
        recursive: false,
      },
      { timeoutMs: 1_000 },
    );
    await expect(f.credential.prepare()).rejects.toThrow("closed");
  });

  it("does not let retiring a resumed generation remove its replacement credential", async () => {
    const f = fixture();
    const replacement = createCodexNativeHookRemoteCredential({
      ...f,
      relay: { ...f.relay, enableRemoteCallback: () => ({ token: "synthetic-replacement" }) },
    });
    expect(replacement.path).toBe(f.credential.path);
    await f.credential.prepare();
    await replacement.prepare();
    await f.credential.dispose();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "fs/writeFile",
      "fs/writeFile",
    ]);
    const replacementWrite = f.request.mock.calls.at(-1)?.[1] as { dataBase64: string };
    expect(JSON.parse(Buffer.from(replacementWrite.dataBase64, "base64").toString())).toMatchObject(
      { token: "synthetic-replacement" },
    );
    await replacement.dispose();
    expect(f.request.mock.calls.at(-1)?.[0]).toBe("fs/remove");
  });

  it("settles an in-flight delivery before removal and refuses execution after disposal", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<JsonObject>();
    f.request.mockImplementationOnce(() => {
      entered.resolve();
      return writing.promise;
    });
    const preparation = f.credential.prepare();
    const failed = expect(preparation).rejects.toThrow("closed during delivery");
    await entered.promise;
    const removal = f.credential.dispose();
    expect(f.request).toHaveBeenCalledTimes(1);
    writing.resolve({});
    await failed;
    await removal;
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["fs/writeFile", "fs/remove"]);
  });

  it("finishes an old removal before publishing its replacement at the stable path", async () => {
    const f = fixture();
    await f.credential.prepare();
    const entered = Promise.withResolvers<void>();
    const removing = Promise.withResolvers<JsonObject>();
    f.request.mockImplementationOnce(() => {
      entered.resolve();
      return removing.promise;
    });
    const oldRemoval = f.credential.dispose();
    await entered.promise;
    const replacement = createCodexNativeHookRemoteCredential(f);
    const replacementWrite = replacement.prepare();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["fs/writeFile", "fs/remove"]);
    removing.resolve({});
    await Promise.all([oldRemoval, replacementWrite]);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "fs/writeFile",
      "fs/remove",
      "fs/writeFile",
    ]);
    await replacement.dispose();
  });

  it("allows a replacement write after a failed removal", async () => {
    const f = fixture();
    await f.credential.prepare();
    f.request.mockRejectedValueOnce(new Error("filesystem unavailable"));
    await expect(f.credential.dispose()).rejects.toThrow("Could not remove");
    const replacement = createCodexNativeHookRemoteCredential(f);
    await expect(replacement.prepare()).resolves.toBeUndefined();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "fs/writeFile",
      "fs/remove",
      "fs/writeFile",
    ]);
    await replacement.dispose();
  });

  it("redacts a remote write error and removes a possibly delivered credential", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("synthetic-relay-capability echoed by server"));
    await expect(f.credential.prepare()).rejects.toThrow(
      /^Could not deliver the native hook relay credential to Codex$/,
    );
    await f.credential.dispose();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["fs/writeFile", "fs/remove"]);
  });

  it("does not deliver after authority is revoked", async () => {
    const f = fixture();
    f.assertCurrent.mockImplementation(() => {
      throw new Error("source revoked");
    });
    await expect(f.credential.prepare()).rejects.toThrow("source revoked");
    expect(f.enableRemoteCallback).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    await f.credential.dispose();
  });
});
