import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";
import { withSessionToolTestCaller as withCaller } from "./tools/sessions-tool.test-helpers.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

afterEach(() => vi.restoreAllMocks());
const sessionKey = "agent:main:main";
const owner = { type: "human", id: "profile-requester" };

function assemble(options: Parameters<typeof createOpenClawCodingTools>[0] = {}, deny?: string[]) {
  return createOpenClawCodingTools({
    config: { tools: { allow: ["sessions", "sessions_create"], deny } },
    sessionKey,
    senderIsOwner: false,
    workspaceDir: process.cwd(),
    ...options,
  });
}
const hasCreate = (deny?: string[]) => assemble({}, deny).some((t) => t.name === "sessions_create");
const actions = expect.arrayContaining(["assign_owner", "patch", "group_set"]);

it.each([false, undefined])("limits assignment for owner=%s", async (senderIsOwner) => {
  const messageProvider = senderIsOwner === false ? "webchat" : undefined;
  const gateway = vi.spyOn(inProcessGateway, "callAgentToolGatewayRequest").mockResolvedValue({
    ok: true,
    key: sessionKey,
    owner: { actor: { ...owner, label: "Requester" } },
  });
  const tools = assemble({
    config: { tools: { allow: ["sessions"] } },
    messageProvider,
    senderIsOwner,
  });
  const tool = expectDefined(
    tools.find((candidate) => candidate.name === "sessions"),
    "sessions",
  );
  const assignmentOnly = senderIsOwner === false;
  expect(tool.parameters).toHaveProperty("properties.action.enum", actions);
  if (assignmentOnly) {
    await expect(
      withCaller(() => tool.execute("refused-patch", { action: "group_set", names: ["ops"] })),
    ).rejects.toThrow("Only assign_owner is available to non-owner callers");
  }
  const action = assignmentOnly
    ? { action: "assign_owner", ownerType: owner.type, ownerId: owner.id }
    : { action: "patch", label: "Scheduled session" };
  const result = await withCaller(() => tool.execute("manage-session", action));
  expect(result.details).toMatchObject({
    status: "updated",
    ...(assignmentOnly ? { owner } : {}),
  });
  expect(gateway).toHaveBeenCalledWith({
    method: assignmentOnly ? "sessions.assignOwner" : "sessions.patch",
    params: { key: sessionKey, ...(assignmentOnly ? { owner } : { label: "Scheduled session" }) },
    ...(assignmentOnly
      ? {
          agentToolCaller: { agentId: "main", sessionKey },
          assertDispatchCurrent: expect.any(Function),
        }
      : {}),
  });
  const denied = assemble({
    config: { tools: { allow: ["sessions"], deny: ["sessions"] } },
  });
  expect(denied.some((candidate) => candidate.name === "sessions")).toBe(false);
});
it("lists creation while requiring admitted session-write authority and preserving explicit denies", async () => {
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "profile-requester",
    scopes: ["operator.sessions.write"],
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const gateway = vi.spyOn(inProcessGateway, "callAgentToolGatewayRequest").mockResolvedValue({});
  const denied = expectDefined(
    assemble().find((tool) => tool.name === "sessions_create"),
    "listed creation tool",
  );
  const refused = await denied.execute("refused-create", {});
  expect(refused.details).toMatchObject({ gated: true });
  expect(gateway).not.toHaveBeenCalled();
  expect(hasCreate(["sessions_create"])).toBe(false);
  await withCaller(async () => {
    const tools = assemble();
    expect(tools.find((tool) => tool.name === "sessions_create")).toBeDefined();
    const sessions = tools.find((tool) => tool.name === "sessions");
    expect(sessions?.parameters).toHaveProperty("properties.action.enum", actions);
    expect(hasCreate(["sessions_create"])).toBe(false);
    expect(hasCreate(["sessions"])).toBe(true);
  }, authority);
});
