import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), outbound: vi.fn() }));
vi.mock("../gateway/server-plugins.js", () => ({
  hasInProcessGatewayContext: () => true,
  getInProcessGatewayRequestContext: () => undefined,
  dispatchGatewayMethodInProcess: mocks.dispatch,
  runWithOperatorToolGatewayCleanupContext: (run: () => unknown) => run(),
}));
vi.mock("./tools/message-tool-execution.js", () => ({
  createMessageTool: () => ({
    name: "message",
    label: "Message",
    description: "Test outbound sink",
    parameters: { type: "object", properties: {} },
    execute: mocks.outbound,
  }),
}));
vi.mock("./run-wait.js", () => ({
  waitForAgentRunReply: async () => ({ status: "ok", replyText: undefined }),
}));
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { projectConversationToolNames } from "./conversation-tool-policy-pipeline.js";
import { captureRequesterToolCap, runWithRequesterToolCap } from "./requester-tool-cap.js";
import { runAgentStep } from "./tools/agent-step.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions_send final tool authority", () => {
  let config: OpenClawConfig;
  let receiverNames: string[];
  afterEach(() => agentStepTesting.setDepsForTest());
  beforeEach(() => {
    config = {
      agents: { list: [{ id: "source" }, { id: "target" }] },
      session: { store: `${dirs.make("send-policy-")}/{agentId}/sessions.json` },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    };
    receiverNames = [];
    mocks.outbound.mockReset().mockResolvedValue({ content: [], details: {} });
    mocks.dispatch.mockReset().mockImplementation(async (method, params) => {
      if (method === "sessions.resolve") {
        return { key: params.key, agentId: "target" };
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      if (method === "agent") {
        const tools = createOpenClawCodingTools({
          config,
          sessionKey: params.sessionKey,
          agentId: "target",
          senderIsOwner: true,
        });
        receiverNames = tools.map((tool) => tool.name);
        await tools.find((tool) => tool.name === "message")?.execute("outbound", {});
        return { runId: params.idempotencyKey };
      }
      return {};
    });
  });

  it.each([true, false])("retains deny-only source authority (deny message: %s)", async (deny) => {
    config.agents!.list![0]!.tools = deny ? { deny: ["message"] } : {};
    const tools = createOpenClawCodingTools({
      config,
      sessionKey: "agent:source:main",
      agentId: "source",
      senderIsOwner: true,
    });
    expect(tools.some((tool) => tool.name === "message")).toBe(!deny);
    const send = tools.find((tool) => tool.name === "sessions_send");
    expect(send).toBeDefined();
    const result = await send!.execute("delegate", {
      sessionKey: "agent:target:main",
      message: "Exercise the outbound sink",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({ status: "no_reply" });
    expect(receiverNames.includes("message")).toBe(!deny);
    expect(mocks.outbound).toHaveBeenCalledTimes(deny ? 0 : 1);
  });
  it("keeps stricter receiving policy without changing an unrelated later turn", async () => {
    config.agents!.list![1]!.tools = { deny: ["message"] };
    const send = createOpenClawCodingTools({
      config,
      agentId: "source",
      sessionKey: "agent:source:main",
      senderIsOwner: true,
    }).find((tool) => tool.name === "sessions_send")!;
    await send.execute("stricter", {
      sessionKey: "agent:target:main",
      message: "hello",
      timeoutSeconds: 1,
    });
    expect(receiverNames).not.toContain("message");
    expect(mocks.outbound).not.toHaveBeenCalled();
    expect(
      createOpenClawCodingTools({
        config,
        agentId: "source",
        sessionKey: "agent:source:main",
        senderIsOwner: true,
      }).map((tool) => tool.name),
    ).toContain("message");
  });

  it("retains the cap across a chained send", async () => {
    config.agents!.list!.push({ id: "third" });
    config.agents!.list![0]!.tools = { deny: ["message"] };
    const originalDispatch = mocks.dispatch.getMockImplementation()!;
    mocks.dispatch.mockImplementation(async (method, params, options) => {
      if (method === "sessions.resolve") {
        return { key: params.key, agentId: params.key.split(":")[1] };
      }
      if (method === "agent" && params.sessionKey === "agent:target:main") {
        const tools = createOpenClawCodingTools({
          config,
          agentId: "target",
          sessionKey: params.sessionKey,
          senderIsOwner: true,
        });
        await tools
          .find((tool) => tool.name === "sessions_send")!
          .execute("chain", {
            sessionKey: "agent:third:main",
            message: "continue",
            timeoutSeconds: 1,
          });
        return { runId: params.idempotencyKey };
      }
      return originalDispatch(method, params, options);
    });
    const tools = createOpenClawCodingTools({
      config,
      agentId: "source",
      sessionKey: "agent:source:main",
      senderIsOwner: true,
    });
    const result = await tools
      .find((tool) => tool.name === "sessions_send")!
      .execute("first", {
        sessionKey: "agent:target:main",
        message: "delegate",
        timeoutSeconds: 1,
      });
    expect(result.details).toMatchObject({ status: "no_reply" });
    expect(receiverNames).not.toContain("message");
    expect(mocks.outbound).not.toHaveBeenCalled();
  });

  it.each([[], ["write"], ["*"], ["group:messaging"]].map((names) => ({ names })))(
    "projects exact cap %j without aliases, groups, or wildcard expansion",
    ({ names }) => {
      const cap = captureRequesterToolCap(names.map((name) => ({ name })));
      const projected = runWithRequesterToolCap(cap, () =>
        projectConversationToolNames({
          capabilityProfile: resolveConversationCapabilityProfile({
            config,
            agentId: "target",
            sessionKey: "agent:target:main",
          }),
          toolNames: ["write", "apply_patch", "message", "sessions_send"],
          warn: () => {},
        }),
      );
      expect(projected).toEqual(names.includes("write") ? ["write"] : []);
    },
  );

  it("caps the direct announcement command ingress", async () => {
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => {
        const tools = createOpenClawCodingTools({
          config,
          agentId: "target",
          sessionKey: "agent:target:main",
          senderIsOwner: true,
        });
        receiverNames = tools.map((tool) => tool.name);
        await tools.find((tool) => tool.name === "message")?.execute("announce-sink", {});
        return { payloads: [{ text: "reply", mediaUrl: null }], meta: { durationMs: 1 } };
      },
    });
    await expect(
      runWithRequesterToolCap(captureRequesterToolCap([{ name: "read" }]), () =>
        runAgentStep({
          sessionKey: "agent:target:main",
          agentId: "target",
          message: "announce",
          transcriptMessage: "",
          extraSystemPrompt: "",
          timeoutMs: 1000,
        }),
      ),
    ).resolves.toBe("reply");
    expect(receiverNames).toEqual(["read"]);
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
});
