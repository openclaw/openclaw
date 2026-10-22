import { createDirectoryTestRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { WhatsAppConnectionOwnerBusyError } from "./connection-owner.js";
import { listWhatsAppDirectoryGroupsLive as listGroups } from "./directory-config.js";

const mocks = vi.hoisted(() => ({
  acquireOwner:
    vi.fn<typeof import("./connection-owner.js").acquireWhatsAppStandaloneConnectionOwner>(),
  createSocket: vi.fn<typeof import("./session.js").createWaDirectorySocket>(),
  getController:
    vi.fn<
      typeof import("./connection-controller-runtime-context.js").getWhatsAppConnectionController
    >(),
  hasPendingOwner: vi.fn(),
  readAuth: vi.fn<typeof import("./auth-store.js").readWebAuthExistsForDecision>(),
  releaseOwner: vi.fn(),
  resolveAuthDir: vi.fn(),
  waitForConnection: vi.fn<typeof import("./session.js").waitForWaConnection>(),
  waitForCreds: vi.fn<typeof import("./session.js").waitForCredsSaveQueueWithTimeout>(),
}));
vi.mock("./active-listener.js", async (original) => ({
  ...(await original<typeof import("./active-listener.js")>()),
  resolveWebAccountId: () => "default",
}));
vi.mock("./accounts.js", async (original) => ({
  ...(await original<typeof import("./accounts.js")>()),
  resolveWhatsAppAuthDir: mocks.resolveAuthDir,
}));
vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: mocks.getController,
  hasPendingWhatsAppConnectionOwner: mocks.hasPendingOwner,
}));
vi.mock("./connection-owner.js", async (original) => ({
  ...(await original<typeof import("./connection-owner.js")>()),
  acquireWhatsAppStandaloneConnectionOwner: mocks.acquireOwner,
}));
vi.mock("./auth-store.js", async (original) => ({
  ...(await original<typeof import("./auth-store.js")>()),
  readWebAuthExistsForDecision: mocks.readAuth,
}));
vi.mock("./session.js", () => ({
  createWaDirectorySocket: mocks.createSocket,
  waitForCredsSaveQueueWithTimeout: mocks.waitForCreds,
  waitForWaConnection: mocks.waitForConnection,
}));

const root = "/tmp/wa-auth";
const first = "120363100000000000@g.us";
const third = "120363300000000000@g.us";
const cfg = { channels: { whatsapp: { authDir: root, groups: { [first]: {}, [third]: {} } } } };
const runtime = createDirectoryTestRuntime() as never;
const params = (overrides: Partial<Parameters<typeof listGroups>[0]> = {}) =>
  ({ cfg, accountId: undefined, runtime, ...overrides }) as never;
const unavailable = (reason: string) =>
  expect(listGroups(params())).rejects.toMatchObject({
    code: "whatsapp_directory_unavailable",
    reason,
  });
const entry = (id: string, name: string) => ({ kind: "group", id, name });
function socket(groups?: Record<string, { id: string; subject?: string }>, onEnd = () => {}) {
  let closed = false;
  return {
    groupFetchAllParticipating: groups === undefined ? vi.fn() : vi.fn().mockResolvedValue(groups),
    end: vi.fn(async () => {
      closed = true;
      onEnd();
    }),
    ws: {
      close: vi.fn(async () => {
        closed = true;
      }),
      get isClosed() {
        return closed;
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getController.mockReturnValue(null);
  mocks.hasPendingOwner.mockReturnValue(false);
  mocks.releaseOwner.mockResolvedValue(undefined);
  mocks.resolveAuthDir.mockImplementation(({ accountId }: { accountId: string }) => ({
    authDir: accountId === "secondary" ? "/tmp/secondary-wa-auth" : root,
    isLegacy: false,
  }));
  mocks.acquireOwner.mockResolvedValue({ release: mocks.releaseOwner });
  mocks.readAuth.mockResolvedValue({ outcome: "stable", exists: true });
  mocks.waitForConnection.mockResolvedValue(undefined);
  mocks.waitForCreds.mockResolvedValue("drained");
});

it("filters and sorts groups through the active owner", async () => {
  const sock = socket({
    [third]: { id: third, subject: "Beta" },
    [first]: { id: first, subject: "Beta Team" },
  });
  mocks.getController.mockReturnValue({ getCurrentSock: () => sock } as never);
  await expect(listGroups(params({ query: "beta", limit: 1 }))).resolves.toEqual([
    entry(first, "Beta Team"),
  ]);
  expect(mocks.acquireOwner).not.toHaveBeenCalled();
});

it.each([false, true])(
  "refuses a standalone socket while gateway owner is pending=%s",
  async (pending) => {
    if (pending) {
      mocks.hasPendingOwner.mockReturnValueOnce(true);
    } else {
      mocks.getController.mockReturnValue({ getCurrentSock: () => null } as never);
    }
    await unavailable("active_owner_unavailable");
    expect(mocks.acquireOwner).not.toHaveBeenCalled();
  },
);

it("does not substitute configured groups after a failed gateway lookup", async () => {
  const sock = socket();
  sock.groupFetchAllParticipating.mockRejectedValue(new Error("query failed"));
  mocks.getController.mockReturnValue({ getCurrentSock: () => sock } as never);
  await unavailable("lookup_failed");
});

it("orders standalone socket closure, credential drain, and ownership release", async () => {
  const order: string[] = [];
  const sock = socket({ [third]: { id: third, subject: "Three" } }, () =>
    order.push("socket-ended"),
  );
  mocks.createSocket.mockResolvedValue(sock as never);
  mocks.waitForCreds.mockImplementationOnce(async () => {
    order.push("creds-drained");
    return "drained";
  });
  mocks.releaseOwner.mockImplementationOnce(async () => {
    order.push("owner-released");
  });
  await expect(listGroups(params())).resolves.toEqual([entry(third, "Three")]);
  expect(mocks.acquireOwner).toHaveBeenCalledWith(root);
  expect(mocks.waitForConnection).toHaveBeenCalledWith(sock, { timeoutMs: 30_000 });
  expect(order).toEqual(["socket-ended", "creds-drained", "owner-released"]);
});

it("reports contention without opening a socket", async () => {
  mocks.acquireOwner.mockRejectedValueOnce(new WhatsAppConnectionOwnerBusyError(root));
  await unavailable("connection_owner_busy");
  expect(mocks.createSocket).not.toHaveBeenCalled();
});

it("resolves the selected account and releases ownership when unlinked", async () => {
  mocks.readAuth.mockResolvedValueOnce({ outcome: "stable", exists: false });
  const namedCfg: OpenClawConfig = {
    channels: { whatsapp: { accounts: { secondary: { enabled: true } } } },
  };
  await expect(listGroups(params({ cfg: namedCfg, accountId: "secondary" }))).rejects.toMatchObject(
    {
      code: "whatsapp_directory_unavailable",
      reason: "not_linked",
    },
  );
  expect(mocks.resolveAuthDir).toHaveBeenCalledWith({ cfg: namedCfg, accountId: "secondary" });
  expect(mocks.acquireOwner).toHaveBeenCalledWith("/tmp/secondary-wa-auth");
  expect(mocks.releaseOwner).toHaveBeenCalledOnce();
});

it("cleans up a socket whose connection fails", async () => {
  const sock = socket();
  mocks.createSocket.mockResolvedValueOnce(sock as never);
  mocks.waitForConnection.mockRejectedValueOnce(new Error("offline"));
  await unavailable("connection_failed");
  expect(sock.end).toHaveBeenCalledOnce();
  expect(mocks.waitForCreds).toHaveBeenCalledWith(root);
  expect(mocks.releaseOwner).toHaveBeenCalledOnce();
});

it("retries retained cleanup after credential drain times out", async () => {
  const sock = socket({});
  mocks.createSocket.mockResolvedValueOnce(sock as never).mockResolvedValueOnce(sock as never);
  mocks.waitForCreds.mockResolvedValueOnce("timed_out");
  await unavailable("cleanup_failed");
  expect(mocks.releaseOwner).not.toHaveBeenCalled();
  await expect(listGroups(params())).resolves.toEqual([]);
  expect(mocks.releaseOwner).toHaveBeenCalledTimes(2);
});
