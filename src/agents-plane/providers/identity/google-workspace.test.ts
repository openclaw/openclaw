import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceIdentityProvider } from "./google-workspace.js";

function mockClient() {
  return {
    users: {
      get: vi.fn().mockResolvedValue({
        primaryEmail: "alice@test.com",
        name: { fullName: "Alice Smith" },
        orgUnitPath: "/Engineering",
        customSchemas: {
          OpenClaw_Agent: {
            agentEnabled: true,
            agentId: "alice-agent",
            modelTier: "opus",
            budgetCap: "200",
            toolAllowlist: "exec,github,email",
            channelRestrictions: "whatsapp,slack",
            agentStatus: "running",
          },
        },
      }),
      list: vi.fn().mockResolvedValue({
        users: [
          {
            primaryEmail: "alice@test.com",
            name: { fullName: "Alice" },
            orgUnitPath: "/Engineering",
          },
          { primaryEmail: "bob@test.com", name: { fullName: "Bob" }, orgUnitPath: "/Sales" },
        ],
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    schemas: {
      get: vi.fn().mockResolvedValue({ schemaName: "OpenClaw_Agent" }),
      insert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("GoogleWorkspaceIdentityProvider", () => {
  let client: ReturnType<typeof mockClient>;
  let provider: GoogleWorkspaceIdentityProvider;

  beforeEach(() => {
    client = mockClient();
    provider = new GoogleWorkspaceIdentityProvider({
      domain: "test.com",
      adminEmail: "admin@test.com",
      client,
    });
  });

  describe("resolveUser", () => {
    it("resolves user with agent config", async () => {
      const user = await provider.resolveUser("alice@test.com");
      expect(user).not.toBeNull();
      expect(user!.email).toBe("alice@test.com");
      expect(user!.displayName).toBe("Alice Smith");
      expect(user!.ou).toBe("/Engineering");
      expect(user!.agentEnabled).toBe(true);
      expect(user!.agentConfig?.modelTier).toBe("opus");
      expect(user!.agentConfig?.tools).toEqual(["exec", "github", "email"]);
      expect(user!.agentConfig?.channels).toEqual(["whatsapp", "slack"]);
    });

    it("returns null for non-existent user", async () => {
      client.users.get.mockRejectedValue({ code: 404 });
      const user = await provider.resolveUser("nobody@test.com");
      expect(user).toBeNull();
    });

    it("returns user without agent config when schema missing", async () => {
      client.users.get.mockResolvedValue({
        primaryEmail: "bob@test.com",
        name: { fullName: "Bob" },
      });
      const user = await provider.resolveUser("bob@test.com");
      expect(user!.agentEnabled).toBe(false);
      expect(user!.agentConfig).toBeUndefined();
    });
  });

  describe("listUsers", () => {
    it("lists all users in domain", async () => {
      const users = await provider.listUsers();
      expect(users).toHaveLength(2);
      expect(users[0].email).toBe("alice@test.com");
    });

    it("passes OU filter", async () => {
      await provider.listUsers({ ou: "/Engineering" });
      expect(client.users.list).toHaveBeenCalledWith(
        expect.objectContaining({ query: "orgUnitPath='/Engineering'" }),
      );
    });
  });

  describe("enableAgent", () => {
    it("sets custom schema fields", async () => {
      await provider.enableAgent("alice@test.com", {
        name: "alice-agent",
        modelTier: "opus",
        budgetCap: 200,
        tools: ["exec", "github"],
        channels: ["whatsapp"],
      });
      expect(client.users.update).toHaveBeenCalledWith({
        userKey: "alice@test.com",
        requestBody: {
          customSchemas: {
            OpenClaw_Agent: expect.objectContaining({
              agentEnabled: true,
              agentId: "alice-agent",
              modelTier: "opus",
              budgetCap: "200",
            }),
          },
        },
      });
    });
  });

  describe("disableAgent", () => {
    it("clears agent config", async () => {
      await provider.disableAgent("alice@test.com");
      expect(client.users.update).toHaveBeenCalledWith({
        userKey: "alice@test.com",
        requestBody: {
          customSchemas: {
            OpenClaw_Agent: expect.objectContaining({
              agentEnabled: false,
              agentStatus: "disabled",
            }),
          },
        },
      });
    });
  });

  describe("ensureSchema", () => {
    it("updates existing schema", async () => {
      await provider.ensureSchema("my_customer");
      expect(client.schemas.get).toHaveBeenCalledOnce();
      expect(client.schemas.update).toHaveBeenCalledOnce();
    });

    it("creates schema if not found", async () => {
      client.schemas.get.mockRejectedValue({ code: 404 });
      await provider.ensureSchema("my_customer");
      expect(client.schemas.insert).toHaveBeenCalledOnce();
    });
  });

  describe("onUserEvent", () => {
    it("returns deprovision for deleted user", async () => {
      const result = await provider.onUserEvent({
        type: "deleted",
        email: "alice@test.com",
        timestamp: new Date().toISOString(),
      });
      expect(result.action).toBe("deprovision");
    });

    it("returns deprovision for suspended user", async () => {
      const result = await provider.onUserEvent({
        type: "suspended",
        email: "alice@test.com",
        timestamp: new Date().toISOString(),
      });
      expect(result.action).toBe("deprovision");
    });

    it("returns provision for created user with agent enabled", async () => {
      const result = await provider.onUserEvent({
        type: "created",
        email: "alice@test.com",
        timestamp: new Date().toISOString(),
      });
      expect(result.action).toBe("provision");
    });

    it("returns none for created user without agent", async () => {
      client.users.get.mockResolvedValue({
        primaryEmail: "bob@test.com",
        name: { fullName: "Bob" },
      });
      const result = await provider.onUserEvent({
        type: "created",
        email: "bob@test.com",
        timestamp: new Date().toISOString(),
      });
      expect(result.action).toBe("none");
    });

    it("returns reconfigure for OU change", async () => {
      const result = await provider.onUserEvent({
        type: "ou-changed",
        email: "alice@test.com",
        timestamp: new Date().toISOString(),
      });
      expect(result.action).toBe("reconfigure");
    });
  });
});
