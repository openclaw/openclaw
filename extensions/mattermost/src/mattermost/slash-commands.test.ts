import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  cleanupSlashCommands,
  DEFAULT_COMMAND_SPECS,
  loadPersistedSlashCommandState,
  loadPersistedSlashCommands,
  MattermostIncompleteBlindCreateError,
  mergePersistedSlashCommands,
  parseSlashCommandPayload,
  removePersistedSlashCommands,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandCachePath,
  resolveCommandText,
  resolveSlashCommandConfig,
  savePersistedSlashCommandState,
  savePersistedSlashCommands,
  shouldBlindCreateFromListError,
} from "./slash-commands.js";

describe("slash-commands", () => {
  async function registerSingleStatusCommand(
    requestImpl: (path: string, init?: { method?: string }) => Promise<unknown>,
  ) {
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
    return registerSlashCommands({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [
        {
          trigger: "oc_status",
          description: "status",
          autoComplete: true,
        },
      ],
    });
  }

  it("parses application/x-www-form-urlencoded payloads", () => {
    const payload = parseSlashCommandPayload(
      "token=t1&team_id=team&channel_id=ch1&user_id=u1&command=%2Foc_status&text=now",
      "application/x-www-form-urlencoded",
    );
    expect(payload).toMatchObject({
      token: "t1",
      team_id: "team",
      channel_id: "ch1",
      user_id: "u1",
      command: "/oc_status",
      text: "now",
    });
  });

  it("parses application/json payloads", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({
        token: "t2",
        team_id: "team",
        channel_id: "ch2",
        user_id: "u2",
        command: "/oc_model",
        text: "gpt-5",
      }),
      "application/json; charset=utf-8",
    );
    expect(payload).toMatchObject({
      token: "t2",
      command: "/oc_model",
      text: "gpt-5",
    });
  });

  it("returns null for malformed payloads missing required fields", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({ token: "t3", command: "/oc_help" }),
      "application/json",
    );
    expect(payload).toBeNull();
  });

  it("resolves command text with trigger map fallback", () => {
    const triggerMap = new Map<string, string>([["oc_status", "status"]]);
    expect(resolveCommandText("oc_status", "   ", triggerMap)).toBe("/status");
    expect(resolveCommandText("oc_status", " now ", triggerMap)).toBe("/status now");
    expect(resolveCommandText("oc_models", " openai ", undefined)).toBe("/models openai");
    expect(resolveCommandText("oc_help", "", undefined)).toBe("/help");
  });

  it("registers both public model slash commands", () => {
    expect(
      DEFAULT_COMMAND_SPECS.filter(
        (spec) => spec.trigger === "oc_model" || spec.trigger === "oc_models",
      ).map((spec) => spec.trigger),
    ).toEqual(["oc_model", "oc_models"]);
  });

  it("normalizes callback path in slash config", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "api/channels/mattermost/command" });
    expect(config.callbackPath).toBe("/api/channels/mattermost/command");
  });

  it("falls back to localhost callback URL for wildcard bind hosts", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "/api/channels/mattermost/command" });
    const callbackUrl = resolveCallbackUrl({
      config,
      gatewayPort: 18789,
      gatewayHost: "0.0.0.0",
    });
    expect(callbackUrl).toBe("http://localhost:18789/api/channels/mattermost/command");
  });

  it("reuses existing command when trigger already points to callback URL", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    expect(result[0]?.managed).toBe(false);
    expect(result[0]?.id).toBe("cmd-1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("skips foreign command trigger collisions instead of mutating non-owned commands", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-foreign-1",
            token: "tok-foreign-1",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") {
        throw new Error("should not mutate foreign commands");
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to create when listing existing commands is forbidden", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        throw new Error(
          "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
        );
      }
      if (path === "/commands" && init?.method === "POST") {
        return {
          id: "cmd-created-1",
          token: "tok-created-1",
          team_id: "team-1",
          creator_id: "bot-user",
          trigger: "oc_status",
          method: "P",
          url: "http://gateway/callback",
          auto_complete: true,
        };
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const result = await registerSingleStatusCommand(request);

    expect(result).toEqual([
      expect.objectContaining({
        id: "cmd-created-1",
        token: "tok-created-1",
        managed: true,
      }),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not blind-create when listing fails for a non-403 error", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        throw new Error("Mattermost API 500 Internal Server Error: database unavailable");
      }
      if (init?.method === "POST") {
        throw new Error("should not blind-create on non-403 list failure");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    await expect(registerSingleStatusCommand(request)).rejects.toThrow(
      "Mattermost API 500 Internal Server Error",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reuses cached commands when listing existing commands is forbidden after restart", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        throw new Error(
          "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
        );
      }
      if (init?.method === "POST") {
        throw new Error("should not recreate cached command");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const client = { request } as unknown as MattermostClient;
    const result = await registerSlashCommands({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [
        {
          trigger: "oc_status",
          description: "status",
          autoComplete: true,
        },
      ],
      cachedCommands: [
        {
          id: "cmd-cached-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-cached-1",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
      ],
    });

    expect(result).toEqual([
      {
        id: "cmd-cached-1",
        trigger: "oc_status",
        teamId: "team-1",
        token: "tok-cached-1",
        callbackUrl: "http://gateway/callback",
        managed: false,
      },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("cleans up blind-created commands when listing fails and registration is incomplete", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        throw new Error(
          "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
        );
      }
      if (path === "/commands" && init?.method === "POST") {
        const body = JSON.parse((init as { body?: string }).body ?? "{}") as { trigger?: string };
        if (body.trigger === "oc_status") {
          return {
            id: "cmd-created-1",
            token: "tok-created-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          };
        }
        throw new Error("Mattermost API 400 Bad Request: trigger already exists");
      }
      if (path === "/commands/cmd-created-1" && init?.method === "DELETE") {
        return undefined;
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const client = { request } as unknown as MattermostClient;

    await expect(
      registerSlashCommands({
        client,
        teamId: "team-1",
        creatorUserId: "bot-user",
        callbackUrl: "http://gateway/callback",
        commands: [
          {
            trigger: "oc_status",
            description: "status",
            autoComplete: true,
          },
          {
            trigger: "oc_help",
            description: "help",
            autoComplete: true,
          },
        ],
      }),
    ).rejects.toThrow("Mattermost API 403 Forbidden");

    expect(request).toHaveBeenCalledWith("/commands/cmd-created-1", { method: "DELETE" });
  });

  it("only deletes commands created in the current blind-create attempt", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        throw new Error(
          "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
        );
      }
      if (path === "/commands" && init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as { trigger?: string };
        if (body.trigger === "oc_help") {
          return {
            id: "cmd-created-2",
            token: "tok-created-2",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_help",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          };
        }
        throw new Error("Mattermost API 400 Bad Request: trigger already exists");
      }
      if (path === "/commands/cmd-created-2" && init?.method === "DELETE") {
        return undefined;
      }
      if (path === "/commands/cmd-cached-1" && init?.method === "DELETE") {
        throw new Error("should not delete cached command");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const client = { request } as unknown as MattermostClient;

    await expect(
      registerSlashCommands({
        client,
        teamId: "team-1",
        creatorUserId: "bot-user",
        callbackUrl: "http://gateway/callback",
        commands: [
          {
            trigger: "oc_status",
            description: "status",
            autoComplete: true,
          },
          {
            trigger: "oc_help",
            description: "help",
            autoComplete: true,
          },
          {
            trigger: "oc_model",
            description: "model",
            autoComplete: true,
          },
        ],
        cachedCommands: [
          {
            id: "cmd-cached-1",
            trigger: "oc_status",
            teamId: "team-1",
            token: "tok-cached-1",
            callbackUrl: "http://gateway/callback",
            managed: true,
          },
        ],
      }),
    ).rejects.toThrow("Mattermost API 403 Forbidden");

    expect(request).toHaveBeenCalledWith("/commands/cmd-created-2", { method: "DELETE" });
    expect(request).not.toHaveBeenCalledWith("/commands/cmd-cached-1", { method: "DELETE" });
  });

  it("surfaces recoverable commands when blind-create rollback cannot delete them", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        throw new Error(
          "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
        );
      }
      if (path === "/commands" && init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as { trigger?: string };
        if (body.trigger === "oc_status") {
          return {
            id: "cmd-created-1",
            token: "tok-created-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          };
        }
        throw new Error("Mattermost API 400 Bad Request: trigger already exists");
      }
      if (path === "/commands/cmd-created-1" && init?.method === "DELETE") {
        throw new Error("Mattermost API 500 Internal Server Error");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const client = { request } as unknown as MattermostClient;
    const error = await registerSlashCommands({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [
        {
          trigger: "oc_status",
          description: "status",
          autoComplete: true,
        },
        {
          trigger: "oc_help",
          description: "help",
          autoComplete: true,
        },
      ],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MattermostIncompleteBlindCreateError);
    expect(error).toMatchObject({
      message: "Mattermost API 403 Forbidden: You do not have the appropriate permissions.",
      recoverableCommands: [
        {
          id: "cmd-created-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-created-1",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
      ],
    });
  });

  it("returns the remaining commands after cleanup", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path === "/commands/cmd-managed-1" && init?.method === "DELETE") {
        return undefined;
      }
      if (path === "/commands/cmd-managed-2" && init?.method === "DELETE") {
        throw new Error("Mattermost API 500 Internal Server Error");
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const remaining = await cleanupSlashCommands({
      client: { request } as unknown as MattermostClient,
      commands: [
        {
          id: "cmd-managed-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-1",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
        {
          id: "cmd-managed-2",
          trigger: "oc_help",
          teamId: "team-1",
          token: "tok-2",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
        {
          id: "cmd-unmanaged-1",
          trigger: "oc_model",
          teamId: "team-1",
          token: "tok-3",
          callbackUrl: "http://gateway/callback",
          managed: false,
        },
      ],
    });

    expect(remaining).toEqual([
      {
        id: "cmd-managed-2",
        trigger: "oc_help",
        teamId: "team-1",
        token: "tok-2",
        callbackUrl: "http://gateway/callback",
        managed: true,
      },
      {
        id: "cmd-unmanaged-1",
        trigger: "oc_model",
        teamId: "team-1",
        token: "tok-3",
        callbackUrl: "http://gateway/callback",
        managed: false,
      },
    ]);
  });

  it("keeps managed commands when cleanup is told not to delete them", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path === "/commands/cmd-managed-2" && init?.method === "DELETE") {
        return undefined;
      }
      throw new Error(`unexpected request path: ${path}`);
    });

    const remaining = await cleanupSlashCommands({
      client: { request } as unknown as MattermostClient,
      commands: [
        {
          id: "cmd-managed-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-1",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
        {
          id: "cmd-managed-2",
          trigger: "oc_help",
          teamId: "team-1",
          token: "tok-2",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
      ],
      shouldDelete: async (command) => command.id !== "cmd-managed-1",
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/commands/cmd-managed-2", { method: "DELETE" });
    expect(remaining).toEqual([
      {
        id: "cmd-managed-1",
        trigger: "oc_status",
        teamId: "team-1",
        token: "tok-1",
        callbackUrl: "http://gateway/callback",
        managed: true,
      },
    ]);
  });

  it("persists slash command cache to disk", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-slash-cache-"));
    const cachePath = resolveSlashCommandCachePath(stateDir, "default");

    try {
      await savePersistedSlashCommands(cachePath, [
        {
          id: "cmd-cache-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-cache-1",
          callbackUrl: "http://gateway/callback",
          managed: true,
        },
      ]);

      const raw = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
        commands?: Array<Record<string, unknown>>;
      };
      expect(raw.commands).toEqual([
        {
          id: "cmd-cache-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-cache-1",
          callbackUrl: "http://gateway/callback",
        },
      ]);

      await expect(loadPersistedSlashCommands(cachePath)).resolves.toEqual([
        {
          id: "cmd-cache-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-cache-1",
          callbackUrl: "http://gateway/callback",
          managed: false,
        },
      ]);

      if (process.platform !== "win32") {
        const dirMode = (await fs.stat(path.dirname(cachePath))).mode & 0o777;
        const fileMode = (await fs.stat(cachePath)).mode & 0o777;
        expect(dirMode).toBe(0o700);
        expect(fileMode).toBe(0o600);
      }

      await removePersistedSlashCommands(cachePath);
      await expect(loadPersistedSlashCommands(cachePath)).resolves.toEqual([]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists slash command cache ownership to disk", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-slash-cache-"));
    const cachePath = resolveSlashCommandCachePath(stateDir, "default");

    try {
      await savePersistedSlashCommandState(cachePath, {
        ownerId: "owner-1",
        commands: [
          {
            id: "cmd-cache-1",
            trigger: "oc_status",
            teamId: "team-1",
            token: "tok-cache-1",
            callbackUrl: "http://gateway/callback",
            managed: true,
          },
        ],
      });

      const raw = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
        ownerId?: string;
        commands?: Array<Record<string, unknown>>;
      };
      expect(raw.ownerId).toBe("owner-1");
      expect(raw.commands).toEqual([
        {
          id: "cmd-cache-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-cache-1",
          callbackUrl: "http://gateway/callback",
        },
      ]);

      await expect(loadPersistedSlashCommandState(cachePath)).resolves.toEqual({
        ownerId: "owner-1",
        commands: [
          {
            id: "cmd-cache-1",
            trigger: "oc_status",
            teamId: "team-1",
            token: "tok-cache-1",
            callbackUrl: "http://gateway/callback",
            managed: false,
          },
        ],
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("treats persisted managed flags as untrusted cache data", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-slash-cache-"));
    const cachePath = resolveSlashCommandCachePath(stateDir, "default");

    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          commands: [
            {
              id: "cmd-cache-1",
              trigger: "oc_status",
              teamId: "team-1",
              token: "tok-cache-1",
              callbackUrl: "http://gateway/callback",
              managed: true,
            },
          ],
        }),
        "utf8",
      );

      await expect(loadPersistedSlashCommands(cachePath)).resolves.toEqual([
        {
          id: "cmd-cache-1",
          trigger: "oc_status",
          teamId: "team-1",
          token: "tok-cache-1",
          callbackUrl: "http://gateway/callback",
          managed: false,
        },
      ]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves untouched cached teams when merging refreshed commands", () => {
    expect(
      mergePersistedSlashCommands({
        cachedCommands: [
          {
            id: "cmd-team-1-old",
            trigger: "oc_status",
            teamId: "team-1",
            token: "tok-team-1-old",
            callbackUrl: "http://gateway/callback",
            managed: true,
          },
          {
            id: "cmd-team-2-old",
            trigger: "oc_help",
            teamId: "team-2",
            token: "tok-team-2-old",
            callbackUrl: "http://gateway/callback",
            managed: true,
          },
        ],
        registeredCommands: [
          {
            id: "cmd-team-1-new",
            trigger: "oc_status",
            teamId: "team-1",
            token: "tok-team-1-new",
            callbackUrl: "http://gateway/callback",
            managed: true,
          },
        ],
        refreshedTeamIds: ["team-1"],
      }),
    ).toEqual([
      {
        id: "cmd-team-2-old",
        trigger: "oc_help",
        teamId: "team-2",
        token: "tok-team-2-old",
        callbackUrl: "http://gateway/callback",
        managed: true,
      },
      {
        id: "cmd-team-1-new",
        trigger: "oc_status",
        teamId: "team-1",
        token: "tok-team-1-new",
        callbackUrl: "http://gateway/callback",
        managed: true,
      },
    ]);
  });

  it("only enables blind-create fallback for 403 list errors", () => {
    expect(
      shouldBlindCreateFromListError(
        new Error("Mattermost API 403 Forbidden: You do not have the appropriate permissions."),
      ),
    ).toBe(true);
    expect(
      shouldBlindCreateFromListError(
        new Error("Mattermost API 500 Internal Server Error: database unavailable"),
      ),
    ).toBe(false);
    expect(shouldBlindCreateFromListError(new Error("socket hang up"))).toBe(false);
  });
});
