import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { LogbookStore } from "./src/store.js";

type PolicyContext = Parameters<OpenClawPluginNodeInvokePolicy["handle"]>[0];

function registerLogbook(runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url))) {
  const captured = createCapturedPluginRegistration({ id: "logbook" });
  captured.api.pluginConfig = { captureEnabled: false };
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  const services: OpenClawPluginService[] = [];
  const methods: Array<{ method: string; options: unknown }> = [];
  captured.api.registerNodeInvokePolicy = (policy) => policies.push(policy);
  captured.api.registerService = (service) => services.push(service);
  captured.api.registerGatewayMethod = (method, _handler, options) => {
    methods.push({ method, options });
  };
  plugin.register({ ...captured.api, runtimeSource });
  return { policies, services, methods };
}

afterEach(() => vi.restoreAllMocks());

describe("logbook gateway methods", () => {
  it("keeps only process-wide status independent of the authenticated profile", () => {
    const { methods } = registerLogbook();
    expect(methods.find((entry) => entry.method === "logbook.status")?.options).toEqual({
      scope: "operator.read",
      profileAccess: "independent",
    });
    for (const registration of methods.filter((entry) => entry.method !== "logbook.status")) {
      expect(registration.options).not.toHaveProperty("profileAccess");
    }
  });

  it.each([
    ["source", "extensions/logbook/index.ts", "extensions/logbook/src/store.worker.ts"],
    ["standalone", "plugins/logbook/dist/index.js", "plugins/logbook/dist/src/store.worker.js"],
    ["bundled", "dist/extensions/logbook/index.js", "dist/extensions/logbook/src/store.worker.js"],
  ] as const)(
    "locates its %s worker from the selected runtime entry",
    async (_layout, entry, worker) => {
      const { services } = registerLogbook(path.resolve(entry));
      const stopBeforeOpening = new Error("worker location captured");
      const open = vi.spyOn(LogbookStore, "open").mockRejectedValueOnce(stopBeforeOpening);
      await expect(
        services[0]!.start({ config: {}, stateDir: "/unused", logger: console }),
      ).rejects.toBe(stopBeforeOpening);
      expect(open).toHaveBeenCalledExactlyOnceWith(
        path.join("/unused", "logbook"),
        pathToFileURL(path.resolve(worker)),
      );
    },
  );
});

describe("logbook snapshot invoke policy", () => {
  it("blocks logbook.snapshot when gateway.nodes.commands.deny lists screen.snapshot", async () => {
    const {
      policies: [policy],
    } = registerLogbook();
    expect(policy?.commands).toEqual(["logbook.snapshot"]);
    const invokeNode = vi.fn();
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["screen.snapshot"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: false, code: "SCREEN_CAPTURE_DENIED" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("invokes the node when screen.snapshot is not denied", async () => {
    const {
      policies: [policy],
    } = registerLogbook();
    const invokeNode = vi.fn().mockResolvedValue({ ok: true, payloadJSON: null });
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["camera.snap"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });
});
