import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../gateway/session-row-projection.test-support.js";
import { resolveGatewayScopedTools } from "../gateway/tool-resolution.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const identity = { sessionKey: "agent:main:preview", sessionId: "conversation", agentId: "main" };
const binding = { ...identity, environmentId: "attached", ownerEpoch: 1, generation: 1 };

function context(dedicated: boolean, attached: boolean, locked = false) {
  const signal = new AbortController().signal;
  const projection = createSessionRowProjectionFixture({
    cfg: {},
    store: {
      [identity.sessionKey]: {
        sessionId: identity.sessionId,
        updatedAt: 1,
        modelSelectionLocked: locked,
      },
    },
  });
  return bindSessionRowProjection(
    {
      portalService: {},
      workerEnvironmentService: {
        getSessionAttachmentStatus: () => (attached ? { attachment: binding } : undefined),
        captureSessionAttachment: () => {
          if (!attached) {
            throw new Error("no secondary attachment");
          }
          return { binding, assertCurrent: () => {}, touch: async () => {} };
        },
        get: () => ({ ...binding, leaseId: "lease", nodeDeviceId: "node", sharedHost: false }),
        getDedicatedNodeLeaseSignal: () => (dedicated ? signal : undefined),
      },
    } as unknown as GatewayRequestContext,
    () => projection,
  );
}

async function tools(
  builder: "agent" | "gateway" | "http",
  cfg: OpenClawConfig = { tools: { profile: "coding" } },
  senderIsOwner = false,
) {
  return builder === "agent"
    ? createOpenClawCodingTools({ ...identity, config: cfg, senderIsOwner })
    : (
        await resolveGatewayScopedTools({
          ...identity,
          cfg,
          senderIsOwner,
          surface: builder === "http" ? "http" : "loopback",
        })
      ).tools;
}

describe("attached conversation portal tool availability", () => {
  it.each([
    ["agent", "scoped", true, true, false, false],
    ["gateway", "scoped", true, true, false, false],
    ["gateway", "global", false, false, false, true],
    ["gateway", "absent", false, true, false, false],
    ["agent", "absent", true, false, false, false],
    ["agent", "absent", true, true, true, false],
    ["http", "absent", true, true, false, false],
  ] as const)(
    "%s has %s portal access (dedicated=%s, attached=%s, locked=%s, owner=%s)",
    async (builder, access, dedicated, attached, locked, owner) => {
      const ctx = context(dedicated, attached, locked);
      await withPluginRuntimeGatewayContextResolver(
        () => ctx,
        async () => {
          const portal = (await tools(builder, undefined, owner)).find(
            (tool) => tool.name === "portal",
          );
          if (access === "scoped") {
            expect(portal).toBeDefined();
            expect(portal?.parameters).not.toHaveProperty("properties.environmentId");
            expect(portal?.description).toContain("attached dedicated worker");
            expect(
              (await tools(builder, { tools: { profile: "coding", deny: ["portal"] } })).some(
                (tool) => tool.name === "portal",
              ),
            ).toBe(false);
          } else if (access === "global") {
            expect(portal?.parameters).toHaveProperty("properties.environmentId");
          } else {
            expect(portal).toBeUndefined();
          }
          if (locked) {
            expect(
              (await tools(builder, undefined, true)).some((tool) => tool.name === "portal"),
            ).toBe(true);
          }
        },
      );
    },
  );
});
