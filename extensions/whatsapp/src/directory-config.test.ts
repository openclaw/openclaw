// Whatsapp tests cover directory config plugin behavior.
import { createDirectoryTestRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryGroupsLive,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
import type { OpenClawConfig } from "./runtime-api.js";

vi.mock("./connection-controller-registry.js", () => ({
  getRegisteredWhatsAppConnectionController: vi.fn(),
}));

vi.mock("./active-listener.js", () => ({
  resolveWebAccountId: vi.fn().mockReturnValue("default"),
}));

import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";

const mockGetCurrentSock = vi.fn();

beforeEach(() => {
  vi.mocked(getRegisteredWhatsAppConnectionController).mockReset();
  mockGetCurrentSock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("whatsapp directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          allowFrom: [
            "whatsapp:+15551230001",
            "15551230002@s.whatsapp.net",
            "120363999999999999@g.us",
          ],
          groups: {
            "120363111111111111@g.us": {},
            "120363222222222222@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryPeersFromConfig({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([
      { kind: "user", id: "+15551230001" },
      { kind: "user", id: "+15551230002" },
    ]);

    await expect(
      listWhatsAppDirectoryGroupsFromConfig({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([
      { kind: "group", id: "120363111111111111@g.us" },
      { kind: "group", id: "120363222222222222@g.us" },
    ]);
  });
});

describe("whatsapp directory groups live", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  function mockController(sock: unknown) {
    vi.mocked(getRegisteredWhatsAppConnectionController).mockReturnValue({
      getCurrentSock: () => sock,
      getActiveListener: () => null,
      getSelfIdentity: () => null,
    });
  }

  it("falls back to config when no socket is available", async () => {
    mockController(null);

    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          groups: {
            "120363111111111111@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryGroupsLive({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([{ kind: "group", id: "120363111111111111@g.us" }]);
  });

  it("returns groups fetched live from the Baileys socket", async () => {
    mockController({
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        "120363111111111111@g.us": {
          id: "120363111111111111@g.us",
          subject: "Family Chat",
        },
        "120363222222222222@g.us": {
          id: "120363222222222222@g.us",
          subject: "Work Group",
        },
      }),
    });

    const cfg = { channels: { whatsapp: {} } } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryGroupsLive({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([
      { kind: "group", id: "120363111111111111@g.us", name: "Family Chat" },
      { kind: "group", id: "120363222222222222@g.us", name: "Work Group" },
    ]);
  });

  it("applies query filter to live results", async () => {
    mockController({
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        "120363111111111111@g.us": {
          id: "120363111111111111@g.us",
          subject: "Family Chat",
        },
        "120363222222222222@g.us": {
          id: "120363222222222222@g.us",
          subject: "Work Group",
        },
        "120363333333333333@g.us": {
          id: "120363333333333333@g.us",
          subject: "Football Fans",
        },
      }),
    });

    const cfg = { channels: { whatsapp: {} } } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryGroupsLive({
        cfg,
        accountId: undefined,
        query: "111111",
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([{ kind: "group", id: "120363111111111111@g.us", name: "Family Chat" }]);
  });

  it("applies limit to live results", async () => {
    mockController({
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        "120363111111111111@g.us": {
          id: "120363111111111111@g.us",
          subject: "Group A",
        },
        "120363222222222222@g.us": {
          id: "120363222222222222@g.us",
          subject: "Group B",
        },
        "120363333333333333@g.us": {
          id: "120363333333333333@g.us",
          subject: "Group C",
        },
      }),
    });

    const cfg = { channels: { whatsapp: {} } } as unknown as OpenClawConfig;

    const result = await listWhatsAppDirectoryGroupsLive({
      cfg,
      accountId: undefined,
      query: undefined,
      limit: 2,
      runtime: runtimeEnv,
    } as never);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("120363111111111111@g.us");
    expect(result[1]!.id).toBe("120363222222222222@g.us");
  });

  it("falls back to config when socket throws", async () => {
    mockController({
      groupFetchAllParticipating: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          groups: {
            "120363111111111111@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryGroupsLive({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([{ kind: "group", id: "120363111111111111@g.us" }]);
  });

  it("handles socket returning empty groups", async () => {
    mockController({
      groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    });

    const cfg = {
      channels: { whatsapp: {} },
    } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryGroupsLive({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([]);
  });
});
