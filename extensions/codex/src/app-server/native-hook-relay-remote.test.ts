import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexNativeHookRemoteCredential } from "./native-hook-relay-remote.js";
import type { JsonObject } from "./protocol.js";

// Each delivery first removes whatever occupies the stable credential name.
const DELIVERY = ["fs/remove", "fs/writeFile"];

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
    credential: createCodexNativeHookRemoteCredential(params),
    methods: () => request.mock.calls.map(([method]) => method),
    payload: () => {
      const write = request.mock.calls.at(-1)?.[1] as { dataBase64: string };
      return JSON.parse(Buffer.from(write.dataBase64, "base64").toString());
    },
    blockNext: () => {
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<JsonObject>();
      request.mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      return { entered: entered.promise, resolve: () => pending.resolve({}) };
    },
  };
}

describe("remote native hook credential projection", () => {
  it("delivers a relay-only capability and removes it once through the captured client", async () => {
    const f = fixture();
    await Promise.all([f.credential.prepare(), f.credential.prepare()]);
    expect(f.relay.enableRemoteCallback).toHaveBeenCalledOnce();
    expect(f.methods()).toEqual(DELIVERY);
    const write = f.request.mock.calls[1];
    expect(write?.[1]).toMatchObject({ path: f.credential.path });
    expect(f.payload()).toEqual({
      url: "https://gateway.example/node/__openclaw__/native-hook/relay-1",
      token: "synthetic-relay-capability",
    });
    expect(f.credential.path).not.toContain("synthetic-relay-capability");
    await Promise.all([f.credential.dispose(), f.credential.dispose()]);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request).toHaveBeenLastCalledWith(
      "fs/remove",
      { path: f.credential.path, force: true, recursive: false },
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
    expect(f.methods()).toEqual([...DELIVERY, ...DELIVERY]);
    expect(f.payload()).toMatchObject({ token: "synthetic-replacement" });
    await replacement.dispose();
    expect(f.request.mock.calls.at(-1)?.[0]).toBe("fs/remove");
  });

  it("settles an in-flight delivery before removal and refuses execution after disposal", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({});
    const writing = f.blockNext();
    const preparation = f.credential.prepare();
    const failed = expect(preparation).rejects.toThrow("closed during delivery");
    await writing.entered;
    const removal = f.credential.dispose();
    expect(f.request).toHaveBeenCalledTimes(2);
    writing.resolve();
    await failed;
    await removal;
    expect(f.methods()).toEqual([...DELIVERY, "fs/remove"]);
  });

  it("finishes an old removal before publishing its replacement at the stable path", async () => {
    const f = fixture();
    await f.credential.prepare();
    const removing = f.blockNext();
    const oldRemoval = f.credential.dispose();
    await removing.entered;
    const replacement = createCodexNativeHookRemoteCredential(f);
    const replacementWrite = replacement.prepare();
    expect(f.methods()).toEqual([...DELIVERY, "fs/remove"]);
    removing.resolve();
    await Promise.all([oldRemoval, replacementWrite]);
    expect(f.methods()).toEqual([...DELIVERY, "fs/remove", ...DELIVERY]);
    await replacement.dispose();
  });

  it("allows a replacement write after a failed removal", async () => {
    const f = fixture();
    await f.credential.prepare();
    f.request.mockRejectedValueOnce(new Error("filesystem unavailable"));
    await expect(f.credential.dispose()).rejects.toThrow("Could not remove");
    const replacement = createCodexNativeHookRemoteCredential(f);
    await expect(replacement.prepare()).resolves.toBeUndefined();
    expect(f.methods()).toEqual([...DELIVERY, "fs/remove", ...DELIVERY]);
    await replacement.dispose();
  });

  it("redacts a remote write error and removes a possibly delivered credential", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("synthetic-relay-capability echoed by server"));
    await expect(f.credential.prepare()).rejects.toThrow(
      /^Could not deliver the native hook relay credential to Codex$/,
    );
    await f.credential.dispose();
    expect(f.methods()).toEqual([...DELIVERY, "fs/remove"]);
  });

  it.skipIf(process.platform === "win32")(
    "replaces a link planted at the stable name instead of writing through it",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "native-hook-credential-"));
      try {
        const credentialDirectory = path.join(root, "hooks");
        const workspaceFile = path.join(root, "workspace", "notes.txt");
        await mkdir(credentialDirectory);
        await mkdir(path.dirname(workspaceFile));
        await writeFile(workspaceFile, "workspace notes");
        const f = fixture();
        // The app-server writes through links and removes the link itself.
        f.request.mockImplementation(async (method, params) => {
          const target = (params as { path: string }).path;
          if (method === "fs/remove") {
            await rm(target, { force: true });
          } else {
            const data = (params as { dataBase64: string }).dataBase64;
            await writeFile(target, Buffer.from(data, "base64"));
          }
          return {};
        });
        const credential = createCodexNativeHookRemoteCredential({
          ...f,
          config: { ...f.config, credentialDirectory },
        });
        await symlink(workspaceFile, credential.path);

        await credential.prepare();

        expect(await readFile(workspaceFile, "utf8")).toBe("workspace notes");
        expect((await lstat(credential.path)).isFile()).toBe(true);
        expect(JSON.parse(await readFile(credential.path, "utf8"))).toMatchObject({
          token: "synthetic-relay-capability",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not deliver after authority is revoked", async () => {
    const f = fixture();
    f.assertCurrent.mockImplementation(() => {
      throw new Error("source revoked");
    });
    await expect(f.credential.prepare()).rejects.toThrow("source revoked");
    expect(f.relay.enableRemoteCallback).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    await f.credential.dispose();
  });
});
