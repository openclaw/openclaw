import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleMeetConfig } from "./src/config.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./src/transports/google-meet-platform-constants.js";

const policyContext = {} as OpenClawPluginNodeInvokePolicyContext;
const lazyModules = [
  "./src/create.js",
  "./src/runtime.js",
  "./src/node-host.js",
  "./src/node-invoke-policy.js",
  "./src/cli.js",
  "openclaw/plugin-sdk/gateway-runtime",
  "openclaw/plugin-sdk/param-readers",
  "openclaw/plugin-sdk/routing",
  "openclaw/plugin-sdk/transcripts",
];

async function twice(action: () => unknown) {
  await action();
  await action();
}

const nodePolicy = (
  handle: OpenClawPluginNodeInvokePolicy["handle"],
): OpenClawPluginNodeInvokePolicy => ({
  commands: [GOOGLE_MEET_NODE_COMMAND],
  dangerous: true,
  handle,
});

describe("google-meet lazy imports", () => {
  afterEach(() => {
    for (const moduleId of lazyModules) {
      vi.doUnmock(moduleId);
    }
    vi.resetModules();
  });

  it("keeps registration cold and activates node owners on demand", async () => {
    const imports = vi.fn();
    let nodeHostBusy = false;
    const delegateHandle = vi.fn<OpenClawPluginNodeInvokePolicy["handle"]>(async () => ({
      ok: true,
    }));
    const createPolicy = vi.fn(() => nodePolicy(delegateHandle));

    const handle = Object.assign(
      async () => {
        nodeHostBusy = true;
        return JSON.stringify({ ok: true });
      },
      { hasActiveWork: () => nodeHostBusy },
    );
    // mock-isolation: Registration must not initialize any runtime owner.
    for (const id of lazyModules) {
      vi.doMock(id, () => {
        imports(id);
        if (id === "./src/node-host.js") {
          return { handleGoogleMeetNodeHostCommand: handle };
        }
        if (id === "./src/node-invoke-policy.js") {
          return { createGoogleMeetChromeNodeInvokePolicy: createPolicy };
        }
        throw new Error(`Unexpected eager import: ${id}`);
      });
    }

    const { default: googleMeetPlugin } = await import("./index.js");
    const api = createTestPluginApi({ id: "google-meet" });
    const nodes = vi.spyOn(api, "registerNodeHostCommand");
    const policies = vi.spyOn(api, "registerNodeInvokePolicy");
    googleMeetPlugin.register(api);
    const node = nodes.mock.calls[0]![0];
    const policy = policies.mock.calls[0]![0];

    expect(node.hasActiveWork?.()).toBe(false);
    expect(imports).not.toHaveBeenCalled();
    await twice(() => node.handle());
    expect(node.hasActiveWork?.()).toBe(true);
    nodeHostBusy = false;
    expect(node.hasActiveWork?.()).toBe(false);
    expect(policy.commands).toEqual([GOOGLE_MEET_NODE_COMMAND]);
    expect(policy.dangerous).toBe(true);
    expect(createPolicy).not.toHaveBeenCalled();
    await twice(() => expect(policy.handle(policyContext)).resolves.toEqual({ ok: true }));
    expect(createPolicy).toHaveBeenCalledTimes(1);
    expect(delegateHandle).toHaveBeenCalledTimes(2);
  });

  it.each(["load", "delegate"])("preserves the node policy %s failure boundary", async (stage) => {
    const failure = new Error(`${stage} failed`);
    // mock-isolation: Distinguish unavailable policy code from an initialized delegate's failure.
    vi.doMock("./src/node-invoke-policy.js", () => {
      if (stage === "load") {
        throw failure;
      }
      return {
        createGoogleMeetChromeNodeInvokePolicy: () =>
          nodePolicy(async () => {
            throw failure;
          }),
      };
    });
    const { createLazyGoogleMeetNodeInvokePolicy } = await import("./src/plugin-registration.js");
    const result = createLazyGoogleMeetNodeInvokePolicy({} as GoogleMeetConfig).handle(
      policyContext,
    );
    if (stage === "load") {
      await expect(result).resolves.toMatchObject({
        ok: false,
        code: "PLUGIN_POLICY_UNAVAILABLE",
        unavailable: true,
      });
    } else {
      await expect(result).rejects.toBe(failure);
    }
  });
});
