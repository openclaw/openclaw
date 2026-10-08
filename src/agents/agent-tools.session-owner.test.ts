import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";
import { withSessionToolTestCaller } from "./tools/sessions-tool.test-helpers.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

afterEach(() => vi.restoreAllMocks());

describe("session responsibility assignment in non-owner turns", () => {
  it.each([
    { senderIsOwner: false, messageProvider: "webchat" },
    { senderIsOwner: false, messageProvider: "test-channel" },
    { senderIsOwner: undefined, messageProvider: undefined },
  ])(
    "limits assignment without channel policy or senderless management changes ($messageProvider)",
    async ({ senderIsOwner, messageProvider }) => {
      const gateway = vi.spyOn(inProcessGateway, "callAgentToolGatewayRequest").mockResolvedValue({
        ok: true,
        key: "agent:main:main",
        owner: { actor: { type: "human", id: "profile-requester", label: "Requester" } },
      });
      const tools = createOpenClawCodingTools({
        config: { tools: { allow: ["sessions"] } },
        sessionKey: "agent:main:main",
        messageProvider,
        senderIsOwner,
        workspaceDir: process.cwd(),
      });
      const tool = tools.find((candidate) => candidate.name === "sessions");
      expect(
        tool,
        "non-owner turns need the visibility-authorized assignment action",
      ).toBeDefined();
      if (!tool) {
        throw new Error("sessions tool missing");
      }
      const assignmentOnly = senderIsOwner === false;
      if (assignmentOnly) {
        expect(tool.parameters).toHaveProperty("properties.action.enum", ["assign_owner"]);
        expect(tool.parameters).not.toHaveProperty("properties.model");
        expect(tool.parameters).toHaveProperty(
          "required",
          expect.arrayContaining(["ownerType", "ownerId", "action"]),
        );
      } else {
        expect(tool.parameters).toHaveProperty(
          "properties.action.enum",
          expect.arrayContaining(["patch", "group_set"]),
        );
      }
      const result = await withSessionToolTestCaller(() =>
        tool.execute(
          "manage-session",
          assignmentOnly
            ? {
                action: "assign_owner",
                ownerType: "human",
                ownerId: "profile-requester",
              }
            : { action: "patch", label: "Scheduled session" },
        ),
      );
      expect(result.details).toMatchObject({
        status: "updated",
        ...(assignmentOnly ? { owner: { type: "human", id: "profile-requester" } } : {}),
      });
      expect(gateway).toHaveBeenCalledWith(
        assignmentOnly
          ? {
              method: "sessions.assignOwner",
              params: { key: "agent:main:main", owner: { type: "human", id: "profile-requester" } },
              agentToolCaller: { agentId: "main", sessionKey: "agent:main:main" },
              assertDispatchCurrent: expect.any(Function),
            }
          : {
              method: "sessions.patch",
              params: { key: "agent:main:main", label: "Scheduled session" },
            },
      );
      const denied = createOpenClawCodingTools({
        config: { tools: { allow: ["sessions"], deny: ["sessions"] } },
        sessionKey: "agent:main:main",
        senderIsOwner: false,
        workspaceDir: process.cwd(),
      });
      expect(denied.some((candidate) => candidate.name === "sessions")).toBe(false);
    },
  );
});
