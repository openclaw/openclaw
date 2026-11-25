import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { createQaTransportAdapter } from "../../qa-transport-registry.js";
import { createTempDirHarness } from "../../temp-dir.test-helper.js";
import { whatsappQaCliRegistration } from "./cli.js";
import { createArchive, createDriver, observedMessage, phones } from "./runtime.test-support.js";
import type { WhatsAppQaRuntimeEnv } from "./whatsapp-live.contracts.js";

const mocks = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  heartbeat: vi.fn<() => Promise<void>>(),
  heartbeatStop: vi.fn<() => Promise<void>>(),
  release: vi.fn<() => Promise<void>>(),
  startDriver: vi.fn<({ authDir }: { authDir: string }) => Promise<WhatsAppQaDriverSession>>(),
  closeDriver: vi.fn<() => Promise<void>>(),
}));

vi.mock("../shared/credential-lease.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/credential-lease.runtime.js")>();
  return {
    ...actual,
    acquireQaCredentialLease: mocks.acquireLease,
    startQaCredentialLeaseHeartbeat(
      lease: Parameters<typeof actual.startQaCredentialLeaseHeartbeat>[0],
    ) {
      const heartbeat = actual.startQaCredentialLeaseHeartbeat(lease);
      return {
        ...heartbeat,
        async stop() {
          await heartbeat.stop();
          await mocks.heartbeatStop();
        },
      };
    },
  };
});

vi.mock("./whatsapp-live.driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whatsapp-live.driver.js")>()),
  startWhatsAppQaDriverSessionWithRetry: mocks.startDriver,
}));

const tempDirs = createTempDirHarness();
const fakeAuth = '{"fixture":"not-a-whatsapp-session"}\n';
let fixtureRoot: string;
let authRoot: string | undefined;
let credentialPayload: WhatsAppQaRuntimeEnv;
let created: Awaited<ReturnType<typeof createQaTransportAdapter>> | undefined;
let observed: WhatsAppQaDriverObservedMessage[];

async function createAdapter() {
  created = await createQaTransportAdapter(
    {
      channelId: "whatsapp",
      driver: "live",
      outputDir: fixtureRoot,
      state: createQaBusState(),
    },
    [expectDefined(whatsappQaCliRegistration.adapterFactory, "WhatsApp adapter factory")],
  );
  return created;
}

async function expectResourcesRetained(sutAuthDir: string) {
  expect.soft(mocks.release, "shared credential must remain leased").not.toHaveBeenCalled();
  expect.soft(mocks.heartbeatStop, "lease heartbeat must remain active").not.toHaveBeenCalled();
  for (const dir of [sutAuthDir, path.join(expectDefined(authRoot, "auth root"), "driver-auth")]) {
    await expect.soft(fs.readFile(path.join(dir, "creds.json"), "utf8")).resolves.toBe(fakeAuth);
  }
}

async function expectLeaseReleased(tickMs = 100) {
  expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledOnce();
  await expect(fs.stat(expectDefined(authRoot, "auth root"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  mocks.heartbeat.mockClear();
  await vi.advanceTimersByTimeAsync(tickMs);
  expect(mocks.heartbeat).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetAllMocks();
  authRoot = undefined;
  created = undefined;
  observed = [];
  fixtureRoot = await fs.realpath(await tempDirs.makeTempDir("whatsapp-qa-cleanup-"));
  const archiveBase64 = await createArchive(fixtureRoot, { "creds.json": fakeAuth });
  credentialPayload = {
    ...phones,
    driverAuthArchiveBase64: archiveBase64,
    sutAuthArchiveBase64: archiveBase64,
  };
  mocks.acquireLease.mockResolvedValue({
    kind: "whatsapp",
    source: "convex",
    heartbeatIntervalMs: 100,
    heartbeat: mocks.heartbeat,
    release: mocks.release,
    payload: credentialPayload,
  });
  mocks.startDriver.mockImplementation(async ({ authDir }) => {
    authRoot = await fs.realpath(path.dirname(authDir));
    return createDriver({
      close: mocks.closeDriver,
      getObservedMessages: () => observed,
      waitForMessage: async () => {
        throw new Error("unexpected driver message wait");
      },
    });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  try {
    if (created) {
      const cleanup = created.cleanupWithoutGateway();
      await vi.advanceTimersByTimeAsync(500);
      await cleanup;
    }
  } finally {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    if (authRoot) {
      await fs.rm(authRoot, { recursive: true, force: true });
    }
    await tempDirs.cleanup();
  }
});

describe("WhatsApp QA adapter cleanup through the suite", () => {
  it("reports a driver polling failure through the transport wait boundary", async () => {
    const transport = await createAdapter();
    const driver = await mocks.startDriver.mock.results[0]!.value;
    const failure = new Error("driver polling failed");
    vi.spyOn(driver, "getObservedMessages").mockImplementation(() => {
      throw failure;
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(transport.adapter.waitForCondition(() => true)).rejects.toBe(failure);
  });

  it.each([
    ["none", undefined],
    ["driver close", mocks.closeDriver],
    ["heartbeat request", undefined],
    ["heartbeat stop", mocks.heartbeatStop],
    ["lease release", mocks.release],
  ] as const)(
    "keeps lease and auth between cleanup phases (failure: %s)",
    async (failureAt, fail) => {
      const transport = await createAdapter();
      const cfg = transport.adapter.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
      const sutAuthDir = expectDefined(
        cfg.channels?.whatsapp?.accounts?.sut?.authDir,
        "SUT auth directory",
      );
      await expectResourcesRetained(sutAuthDir);
      if (failureAt === "heartbeat request") {
        mocks.heartbeat.mockRejectedValueOnce(new Error("heartbeat request failed"));
      }
      const lastReply = observedMessage("last-reply", { text: "last reply before cleanup" });
      observed.push(lastReply);
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.adapter.state.getSnapshot().messages.map(({ text }) => text)).toEqual([
        "last reply before cleanup",
      ]);
      if (failureAt === "heartbeat request") {
        await expect(transport.adapter.waitForCondition(() => true)).rejects.toThrow(
          'Credential lease heartbeat failed for kind "whatsapp": heartbeat request failed',
        );
      }

      const failure = new Error(`${failureAt} failed`);
      fail?.mockRejectedValueOnce(failure);
      const before = transport.cleanupBeforeGatewayStop();
      const drained =
        failureAt === "driver close"
          ? expect(before).rejects.toBe(failure)
          : expect(before).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(499);
      expect(mocks.closeDriver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await drained;
      await expectResourcesRetained(sutAuthDir);
      mocks.heartbeat.mockClear();
      observed.push({ ...lastReply, text: "must not poll after cleanup" });
      await vi.advanceTimersByTimeAsync(1_000);
      if (failureAt !== "heartbeat request") {
        expect(mocks.heartbeat).toHaveBeenCalled();
      }
      expect(transport.adapter.state.getSnapshot().messages).toHaveLength(1);
      const after = transport.cleanupAfterGatewayStop();
      await (fail && failureAt !== "driver close"
        ? expect(after).rejects.toBe(failure)
        : expect(after).resolves.toBeUndefined());
      await expectLeaseReleased();
      if (fail) {
        await expect(transport.cleanupWithoutGateway()).rejects.toBe(failure);
        expect(mocks.closeDriver).toHaveBeenCalledOnce();
        expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
        expect(mocks.release).toHaveBeenCalledOnce();
        created = undefined;
      }
    },
  );

  it("stops the heartbeat and releases the lease when the auth root cannot be created", async () => {
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("auth root creation failed"));

    await expect(createAdapter()).rejects.toThrow("auth root creation failed");

    expect(mocks.startDriver).not.toHaveBeenCalled();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
  });

  it("does not leave a pending auth unpack able to recreate the root after rollback", async () => {
    credentialPayload.driverAuthArchiveBase64 = Buffer.from("not a tar archive").toString("base64");
    const roots = vi.spyOn(fs, "mkdtemp");
    const mkdir = vi.spyOn(fs, "mkdir");
    await expect(createAdapter()).rejects.toThrow(/tar/);
    authRoot = await roots.mock.results[0]!.value;
    // Sequential staging must never start a second writer after the first unpack fails.
    expect(mkdir.mock.calls.some(([dir]) => path.basename(String(dir)) === "sut-auth")).toBe(false);
    expect(mocks.startDriver).not.toHaveBeenCalled();
    await expectLeaseReleased();
  });

  it.each([
    ["none", undefined],
    ["heartbeat stop", mocks.heartbeatStop],
    ["lease release", mocks.release],
  ] as const)(
    "immediately removes auth and releases the lease after initialization fails (cleanup failure: %s)",
    async (failureAt, fail) => {
      mocks.startDriver.mockImplementation(async ({ authDir }) => {
        authRoot = await fs.realpath(path.dirname(authDir));
        await expectResourcesRetained(path.join(authRoot, "sut-auth"));
        throw new Error("driver initialization failed");
      });
      fail?.mockRejectedValueOnce(new Error(`${failureAt} failed`));
      await expect(createAdapter()).rejects.toThrow(
        failureAt === "none" ? "driver initialization failed" : `${failureAt} failed`,
      );
      await expectLeaseReleased(1_000);
    },
  );
});
