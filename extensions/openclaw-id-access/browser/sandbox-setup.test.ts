import { expect, it, vi } from "vitest";
import { askAgentToSetUpSandbox } from "./sandbox-setup.js";
import type { Role } from "./types.js";

const guest: Role = {
  name: "guest",
  defined: true,
  sessions: "view",
  admin: false,
  requiresSandbox: true,
  sandbox: {
    ready: false,
    reason: "image_missing",
    backend: "docker",
    image: "openclaw-sandbox:trixie-slim",
    doctorBuilds: true,
  },
};

it("starts a docked conversation with the default agent and sends the reported problem", async () => {
  const request = vi.fn(async () => ({}));
  const create = vi.fn(async () => "agent:main:dock:sandbox");
  const openSession = vi.fn();
  const open = vi.fn();
  await askAgentToSetUpSandbox(
    {
      agents: { defaultId: "main", selectedId: "other" } as never,
      sessions: { create, open } as never,
      dock: { openSession } as never,
      request: request as never,
    },
    [guest],
  );
  expect(create).toHaveBeenCalledWith({
    agentId: "main",
    displayName: "Sandbox setup",
    surface: "plugin-dock",
  });
  expect(request).toHaveBeenCalledWith("chat.send", {
    sessionKey: "agent:main:dock:sandbox",
    agentId: "main",
    message: expect.stringContaining(
      "the sandbox image openclaw-sandbox:trixie-slim is missing from Docker",
    ),
    idempotencyKey: "access-sandbox-setup:agent:main:dock:sandbox",
  });
  expect(openSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessionKey: "agent:main:dock:sandbox", agentId: "main" }),
  );
  expect(open).not.toHaveBeenCalled();
});

it("opens the conversation when the host has no dock, and fails without an agent", async () => {
  const open = vi.fn();
  const create = vi.fn(async () => "agent:main:sandbox");
  const host = {
    agents: { defaultId: null, selectedId: "main" } as never,
    sessions: { create, open } as never,
    request: vi.fn(async () => ({})) as never,
  };
  await askAgentToSetUpSandbox(host, [guest]);
  expect(create).toHaveBeenCalledWith({ agentId: "main", displayName: "Sandbox setup" });
  expect(open).toHaveBeenCalledWith({ sessionKey: "agent:main:sandbox", agentId: "main" });
  await expect(
    askAgentToSetUpSandbox({ ...host, agents: { defaultId: null, selectedId: null } as never }, [
      guest,
    ]),
  ).rejects.toThrow("No agent is available");
});
