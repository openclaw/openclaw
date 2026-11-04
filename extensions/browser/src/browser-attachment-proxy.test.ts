import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  active: true,
  epoch: 7,
  revokeOnSave: false,
  saves: 0,
  failSaveAt: 0,
  allowedSources: [] as string[],
  call: vi.fn<
    (method: string, options: unknown, params: Record<string, unknown>) => Promise<unknown>
  >(),
  host: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: state.call,
  withGatewayToolAttachmentRead: async (
    paths: readonly string[],
    consume: (assert: () => void) => Promise<unknown>,
  ) => {
    if (paths.some((file) => !state.allowedSources.includes(file))) {
      throw new Error("foreign upload source");
    }
    return await consume(() => {
      if (!state.active) {
        throw new Error("guest revoked");
      }
    });
  },
  readGatewayToolOperatorScopes: () => ["operator.sessions.write"],
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => state.root,
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  get CONFIG_DIR() {
    return state.root;
  },
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  saveMediaBuffer: async (buffer: Buffer) => {
    state.saves++;
    if (state.failSaveAt === state.saves) {
      throw new Error("synthetic second save failure");
    }
    const file = path.join(
      state.root,
      state.saves === 1 ? "download.bin" : `download-${state.saves}.bin`,
    );
    await fs.writeFile(file, buffer);
    if (state.revokeOnSave) {
      state.active = false;
    }
    return { path: file, id: "browser-owned" };
  },
}));
vi.mock("./browser/client-fetch.js", async (original) => ({
  ...(await original<typeof import("./browser/client-fetch.js")>()),
  fetchBrowserJson: state.host,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => ({}),
}));
let createProxy: typeof import("./browser-node-proxy.js").createBrowserNodeProxyRequest;
let createTool: typeof import("./browser-tool.js").createBrowserTool;
const bytes = Buffer.from([0, 255, 128, 1, 0, 254]);
beforeEach(async () => {
  state.root = path.join(
    process.cwd(),
    ".openclaw/tmp/guest-relay-proof/browser-attachment-fixture",
  );
  await fs.mkdir(path.join(state.root, "media/inbound"), { recursive: true });
  await fs.writeFile(path.join(state.root, "media/inbound/input.bin"), bytes);
  state.active = true;
  state.epoch = 7;
  state.revokeOnSave = false;
  state.saves = 0;
  state.failSaveAt = 0;
  state.allowedSources = [path.join(state.root, "media/inbound/input.bin")];
  state.call.mockReset();
  state.host.mockReset();
  state.host.mockImplementation(() => {
    throw new Error("Gateway host fallback forbidden");
  });
  state.call.mockImplementation(async (method, _options, params) => {
    if (!state.active) {
      throw new Error("guest revoked");
    }
    if (params.environmentId !== "env-owned") {
      throw new Error("foreign environment");
    }
    if (method === "environments.session.status") {
      return {
        attachment: {
          environmentId: "env-owned",
          ownerEpoch: state.epoch,
          generation: 3,
          closed: false,
        },
      };
    }
    if (method !== "environments.session.invoke") {
      throw new Error("unexpected Gateway browser route");
    }
    return {
      ok: true,
      payload: {
        result: { ok: true, path: "/node/download.bin" },
        files: [
          {
            path: "/node/download.bin",
            mimeType: "application/octet-stream",
            base64: bytes.toString("base64"),
          },
        ],
      },
    };
  });
  ({ createBrowserNodeProxyRequest: createProxy } = await import("./browser-node-proxy.js"));
  ({ createBrowserTool: createTool } = await import("./browser-tool.js"));
});
afterEach(async () => {
  if (state.root) {
    await fs.rm(state.root, { recursive: true, force: true });
  }
});
it("stages authorized inbound upload bytes into the owned node upload protocol", async () => {
  const proxy = createProxy({ environmentId: "env-owned", allowAutomaticHostFallback: true });
  await proxy({
    method: "POST",
    path: "/hooks/file-chooser",
    body: { paths: ["media://inbound/input.bin"] },
  });
  const invoked = state.call.mock.calls.find(
    ([method]) => method === "environments.session.invoke",
  )?.[2];
  expect(invoked).toMatchObject({
    environmentId: "env-owned",
    expectedOwnerEpoch: 7,
    expectedGeneration: 3,
    command: "browser.proxy.upload.v1",
    params: { body: {}, upload: { files: [{ contentBase64: bytes.toString("base64") }] } },
  });
  expect(invoked).not.toHaveProperty("nodeId");
  expect(state.host).not.toHaveBeenCalled();
});
it("persists and rewrites downloaded binary artifact bytes", async () => {
  const proxy = createProxy({ environmentId: "env-owned", allowAutomaticHostFallback: false });
  const result = await proxy({ method: "GET", path: "/download" });
  expect(await fs.readFile(path.join(state.root, "download.bin"))).toEqual(bytes);
  expect(result).toMatchObject({ path: path.join(state.root, "download.bin") });
});
it("denies a foreign environment before upload data is dispatched and never falls back", async () => {
  const proxy = createProxy({ environmentId: "env-foreign", allowAutomaticHostFallback: true });
  await expect(
    proxy({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: ["media://inbound/input.bin"] },
    }),
  ).rejects.toThrow("foreign");
  expect(state.call.mock.calls.some(([method]) => method === "environments.session.invoke")).toBe(
    false,
  );
  expect(state.host).not.toHaveBeenCalled();
});
it("does not publish a downloaded artifact after revocation during media save", async () => {
  state.revokeOnSave = true;
  const proxy = createProxy({ environmentId: "env-owned", allowAutomaticHostFallback: false });
  await expect(proxy({ method: "GET", path: "/download" })).rejects.toThrow("revoked");
  await expect(fs.stat(path.join(state.root, "download.bin"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});
it("routes the public browser tool to its attachment even when host control is disabled", async () => {
  const tool = createTool({ allowHostControl: false, agentSessionKey: "agent:main:owned" });
  await tool.execute("status", { action: "status", environmentId: "env-owned" });
  expect(state.call.mock.calls.some(([method]) => method === "environments.session.invoke")).toBe(
    true,
  );
  expect(state.host).not.toHaveBeenCalled();
  await expect(
    tool.execute("foreign-selector", {
      action: "status",
      environmentId: "env-owned",
      target: "host",
    }),
  ).rejects.toThrow("not both");
});

it("fences staged uploads when the attachment epoch changes during preparation", async () => {
  const original = state.call.getMockImplementation();
  if (!original) {
    throw new Error("missing Gateway fixture");
  }
  let statuses = 0;
  state.call.mockImplementation(async (method, options, params) => {
    if (method === "environments.session.status" && ++statuses === 2) {
      state.epoch++;
    }
    return original(method, options, params);
  });
  const proxy = createProxy({ environmentId: "env-owned", allowAutomaticHostFallback: false });
  await expect(
    proxy({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { paths: ["media://inbound/input.bin"] },
    }),
  ).rejects.toThrow("owner changed");
  expect(state.call.mock.calls.some(([method]) => method === "environments.session.invoke")).toBe(
    false,
  );
});

it("does not accept Gateway routing or media references from the remote browser", async () => {
  const original = state.call.getMockImplementation();
  if (!original) {
    throw new Error("missing Gateway fixture");
  }
  state.call.mockImplementation(async (method, options, params) =>
    method === "environments.session.invoke"
      ? {
          ok: true,
          payload: {
            result: {
              ok: true,
              browserTab: { target: "host" },
              browserDashboard: "foreign",
              media: { mediaUrls: ["/host/other-artifact"] },
              localPath: "/host/other-artifact",
            },
          },
        }
      : original(method, options, params),
  );
  const result = await createProxy({
    environmentId: "env-owned",
    allowAutomaticHostFallback: false,
  })({ method: "GET", path: "/status" });
  expect(result).toEqual({ ok: true, environmentId: "env-owned" });
});

it("rolls back a partial multi-file export but retains pre-existing shared files", async () => {
  const preexisting = path.join(state.root, "preexisting-shared.bin");
  await fs.writeFile(preexisting, "pre-existing user artifact");
  const original = state.call.getMockImplementation();
  if (!original) {
    throw new Error("missing Gateway fixture");
  }
  state.failSaveAt = 2;
  state.call.mockImplementation(async (method, options, params) =>
    method === "environments.session.invoke"
      ? {
          ok: true,
          payload: {
            result: { path: "/node/first.bin", imagePath: "/node/second.bin" },
            files: [
              {
                path: "/node/first.bin",
                mimeType: "application/octet-stream",
                base64: bytes.toString("base64"),
              },
              {
                path: "/node/second.bin",
                mimeType: "application/octet-stream",
                base64: bytes.toString("base64"),
              },
            ],
          },
        }
      : original(method, options, params),
  );
  await expect(
    createProxy({ environmentId: "env-owned", allowAutomaticHostFallback: false })({
      method: "POST",
      path: "/pdf",
    }),
  ).rejects.toThrow("second save failure");
  await expect(fs.stat(path.join(state.root, "download.bin"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  expect(await fs.readFile(preexisting, "utf8")).toBe("pre-existing user artifact");
});

it("rejects a known other-principal inbound URI before file read and dispatch", async () => {
  await fs.writeFile(
    path.join(state.root, "media/inbound/other-principal.bin"),
    "synthetic B-owned bytes",
  );
  const reading = vi.spyOn(fs, "readFile");
  try {
    await expect(
      createProxy({ environmentId: "env-owned", allowAutomaticHostFallback: false })({
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: ["media://inbound/other-principal.bin"] },
      }),
    ).rejects.toThrow("foreign upload source");
    expect(reading).not.toHaveBeenCalled();
    expect(state.call.mock.calls.some(([method]) => method === "environments.session.invoke")).toBe(
      false,
    );
  } finally {
    reading.mockRestore();
  }
});
