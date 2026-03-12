import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const resolveMatrixAuthContextMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
}));

import {
  resolveSharedMatrixClient,
  stopSharedClient,
  stopSharedClientForAccount,
} from "./shared.js";

function authFor(accountId: string): MatrixAuth {
  return {
    accountId,
    homeserver: "https://matrix.example.org",
    userId: `@${accountId}:example.org`,
    accessToken: `token-${accountId}`,
    password: "secret", // pragma: allowlist secret
    deviceId: `${accountId.toUpperCase()}-DEVICE`,
    deviceName: `${accountId} device`,
    initialSyncLimit: undefined,
    encryption: false,
  };
}

function createMockClient(name: string) {
  const client = {
    name,
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    crypto: undefined,
  };
  return client;
}

describe("resolveSharedMatrixClient", () => {
  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    resolveMatrixAuthContextMock.mockReset();
    createMatrixClientMock.mockReset();
    resolveMatrixAuthContextMock.mockImplementation(
      ({ accountId }: { accountId?: string | null } = {}) => ({
        cfg: undefined,
        env: undefined,
        accountId: accountId ?? "default",
        resolved: {},
      }),
    );
  });

  afterEach(() => {
    stopSharedClient();
    vi.clearAllMocks();
  });

  it("keeps account clients isolated when resolves are interleaved", async () => {
    const mainAuth = authFor("main");
    const poeAuth = authFor("ops");
    const mainClient = createMockClient("main");
    const poeClient = createMockClient("ops");

    resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
      accountId === "ops" ? poeAuth : mainAuth,
    );
    createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) => {
      if (accountId === "ops") {
        return poeClient;
      }
      return mainClient;
    });

    const firstMain = await resolveSharedMatrixClient({ accountId: "main", startClient: false });
    const firstPoe = await resolveSharedMatrixClient({ accountId: "ops", startClient: false });
    const secondMain = await resolveSharedMatrixClient({ accountId: "main" });

    expect(firstMain).toBe(mainClient);
    expect(firstPoe).toBe(poeClient);
    expect(secondMain).toBe(mainClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    expect(mainClient.start).toHaveBeenCalledTimes(1);
    expect(poeClient.start).toHaveBeenCalledTimes(0);
  });

  it("stops only the targeted account client", async () => {
    const mainAuth = authFor("main");
    const poeAuth = authFor("ops");
    const mainClient = createMockClient("main");
    const poeClient = createMockClient("ops");

    resolveMatrixAuthMock.mockImplementation(async ({ accountId }: { accountId?: string }) =>
      accountId === "ops" ? poeAuth : mainAuth,
    );
    createMatrixClientMock.mockImplementation(async ({ accountId }: { accountId?: string }) => {
      if (accountId === "ops") {
        return poeClient;
      }
      return mainClient;
    });

    await resolveSharedMatrixClient({ accountId: "main", startClient: false });
    await resolveSharedMatrixClient({ accountId: "ops", startClient: false });

    stopSharedClientForAccount(mainAuth);

    expect(mainClient.stop).toHaveBeenCalledTimes(1);
    expect(poeClient.stop).toHaveBeenCalledTimes(0);

    stopSharedClient();

    expect(poeClient.stop).toHaveBeenCalledTimes(1);
  });

  it("reuses the effective implicit account instead of keying it as default", async () => {
    const poeAuth = authFor("ops");
    const poeClient = createMockClient("ops");

    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: undefined,
      env: undefined,
      accountId: "ops",
      resolved: {},
    });
    resolveMatrixAuthMock.mockResolvedValue(poeAuth);
    createMatrixClientMock.mockResolvedValue(poeClient);

    const first = await resolveSharedMatrixClient({ startClient: false });
    const second = await resolveSharedMatrixClient({ startClient: false });

    expect(first).toBe(poeClient);
    expect(second).toBe(poeClient);
    expect(resolveMatrixAuthMock).toHaveBeenCalledWith({
      cfg: undefined,
      env: undefined,
      accountId: "ops",
    });
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
    expect(createMatrixClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
      }),
    );
  });

  it("rejects mismatched explicit account ids when auth is already resolved", async () => {
    await expect(
      resolveSharedMatrixClient({
        auth: authFor("ops"),
        accountId: "main",
        startClient: false,
      }),
    ).rejects.toThrow("Matrix shared client account mismatch");
  });
});
