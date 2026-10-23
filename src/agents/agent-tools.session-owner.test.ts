import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { SANDBOX_DEFAULT_TOOL_ALLOW, type SandboxToolPolicy } from "./sandbox/types.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
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
it("exposes creation only with admitted session-write authority and preserves explicit denies", async () => {
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "profile-requester",
    scopes: ["operator.sessions.write"],
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const gated = assemble().find((tool) => tool.name === "sessions_create")!;
  expect((await gated.execute("denied", {})).details).toMatchObject({ gated: true });
  await withCaller(async () => {
    const tools = assemble();
    expect(tools.find((tool) => tool.name === "sessions_create")).toBeDefined();
    const sessions = tools.find((tool) => tool.name === "sessions");
    expect(sessions?.parameters).toHaveProperty("properties.action.enum", actions);
    expect(hasCreate(["sessions_create"])).toBe(false);
    expect(hasCreate(["sessions"])).toBe(true);
  }, authority);
});

it("keeps default sandbox declarations stable without widening callable authority", async () => {
  const allow = ["read"];
  const sandboxToolPolicy: SandboxToolPolicy = {
    allow,
    deny: [],
    [SANDBOX_DEFAULT_TOOL_ALLOW]: allow,
  };
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "profile-requester",
    scopes: ["operator.sessions.write"],
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const surface = (tools: ReturnType<typeof assemble>) =>
    tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir: process.cwd(),
    tools: sandboxToolPolicy,
    fsBridge: createHostSandboxFsBridge(process.cwd()),
  });
  const withoutAuthority = assemble({ sandbox });
  const withAuthority = await withCaller(async () => assemble({ sandbox }), authority);
  const ownerTools = await withCaller(
    async () => assemble({ sandbox, senderIsOwner: true }),
    authority,
  );
  expect(withoutAuthority.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["sessions", "sessions_create"]),
  );
  expect(surface(withoutAuthority)).toEqual(surface(withAuthority));
  expect(surface(ownerTools)).toEqual(surface(withAuthority));
  for (const tools of [withoutAuthority, ownerTools]) {
    for (const name of ["sessions", "sessions_create"]) {
      expect(
        (await tools.find((tool) => tool.name === name)!.execute("denied", {})).details,
      ).toMatchObject({ gated: true });
    }
  }
  const denied = assemble({
    sandbox: { ...sandbox, tools: { ...sandboxToolPolicy, deny: ["sessions*"] } },
  });
  expect(denied.some((tool) => tool.name.startsWith("sessions"))).toBe(false);
});
