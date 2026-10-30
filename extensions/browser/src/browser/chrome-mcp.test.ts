import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi, type MockInstance } from "vitest";
// Route tests mock the public facade in shared workers; exercise the real owners here.
import {
  clickChromeMcpCoords,
  clickChromeMcpElement,
  closeChromeMcpTab,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  hoverChromeMcpElement,
  navigateChromeMcpPage,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  uploadChromeMcpFile,
  withChromeMcpDocument,
} from "./chrome-mcp-actions.js";
import { ChromeMcpDocumentUnavailableError } from "./chrome-mcp-contracts.js";
import { normalizeChromeMcpOptions } from "./chrome-mcp-options.js";
import { refreshChromeMcpCleanupProcess } from "./chrome-mcp-process.js";
import {
  closeChromeMcpSession,
  getChromeMcpPid,
  getChromeMcpSessionOwner,
} from "./chrome-mcp-session.js";
import {
  ensureChromeMcpAvailable,
  listChromeMcpTabs,
  openChromeMcpTab,
} from "./chrome-mcp-tabs.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import {
  createFakeSession,
  createPageSession,
  fakeListPagesResult,
  FAKE_TARGET_1,
  installChromeMcpSessionTestHooks,
  pagesResult,
  setChromeMcpSessionFactoryForTest,
  snapshotWithControls,
  textResult,
  waitForChromeMcpState,
  type ChromeMcpSessionFactory,
  type SessionPage,
  type ToolCall,
} from "./chrome-mcp.test-support.js";

const { mockChromeMcpProcesses } = await vi.hoisted(
  () => import("./chrome-mcp-process.test-support.js"),
);

vi.mock("./chrome-mcp-connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chrome-mcp-connect.js")>();
  return { ...actual, createChromeMcpSession: vi.fn(actual.createChromeMcpSession) };
});

type ChromeMcpSession = ReturnType<ChromeMcpSessionFactory>;
type CloseMock = MockInstance<ChromeMcpSession["client"]["close"]>;

const fakeTarget = { profileName: "chrome-live", targetId: FAKE_TARGET_1 };

function installFakeSessions(
  configure: (session: ChromeMcpSession, call: number, close: CloseMock) => void,
) {
  const closeMocks: CloseMock[] = [];
  const factory = vi.fn<ChromeMcpSessionFactory>(() => {
    const session = createFakeSession();
    const close = vi.spyOn(session.client, "close");
    closeMocks.push(close);
    configure(session, closeMocks.length, close);
    return session;
  });
  setChromeMcpSessionFactoryForTest(factory);
  return { factory, closeMocks };
}

function targetFor(targetId: string) {
  return { profileName: "chrome-live", targetId };
}

function processSnapshot(pid: number, ppid: number, identity = `start-${pid}`) {
  return { pid, ppid, identity };
}

function installProcessSession() {
  const session = createFakeSession();
  session.processCleanup = { status: "open" };
  const closeMock = vi.spyOn(session.client, "close");
  const factory = vi.fn(() => session);
  setChromeMcpSessionFactoryForTest(factory);
  return { session, closeMock, factory };
}

function mockCleanupProcesses(mocks: Parameters<typeof mockChromeMcpProcesses>[0]) {
  mockChromeMcpProcesses({ sleep: vi.fn().mockResolvedValue(undefined), ...mocks });
}

describe("chrome MCP page parsing", () => {
  installChromeMcpSessionTestHooks();

  const credentialEndpoint =
    "https://fixture-user:fixture-password@browser.example/?token=fixture-token";
  it.each([
    [
      "invalid",
      "--browserUrl",
      credentialEndpoint.replace("browser.example", "browser.example:bad"),
    ],
    ["wrong protocol", "--wsEndpoint", credentialEndpoint],
  ])(
    "rejects %s endpoint arguments before creating a session without echoing secrets",
    async (_label, flag, endpoint) => {
      const factory = vi.fn(() => createFakeSession());
      setChromeMcpSessionFactoryForTest(factory);

      const attempt = ensureChromeMcpAvailable("chrome-live", { mcpArgs: [flag, endpoint] });

      await expect(attempt).rejects.toThrow(/endpoint arguments/);
      await expect(attempt).rejects.not.toThrow(/fixture-user|fixture-password|fixture-token/);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("binds macOS ancestry, start time, and executable command in one snapshot row", async () => {
    mockChromeMcpProcesses({ platform: "darwin" });
    vi.spyOn(processRuntime, "runExec").mockResolvedValue({
      stdout:
        "  123   1 Fri Jul 11 15:00:00 2026 /Applications/Google Chrome --remote-debugging-port=0",
      stderr: "",
    });
    const session = createFakeSession();
    session.processCleanup = { status: "open" };
    await refreshChromeMcpCleanupProcess(session);
    expect(session.processCleanup).toEqual({
      status: "tracked",
      target: {
        root: {
          pid: 123,
          identity:
            "darwin:Fri Jul 11 15:00:00 2026|/Applications/Google Chrome --remote-debugging-port=0",
        },
        descendants: [],
      },
    });
  });

  it("closes the exact cached client before replacing a session whose process exited", async () => {
    const first = createPageSession({ pid: 201 });
    const factory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValue(createPageSession({ pid: 202 }));
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live");
    (first.transport as { pid: number | null }).pid = null;

    await listChromeMcpTabs("chrome-live");

    expect(factory).toHaveBeenCalledTimes(2);
    expect(vi.spyOn(first.client, "close")).toHaveBeenCalledOnce();
  });

  it("retires a closed target and issues a new handle when Chrome reuses its page id", async () => {
    const pages: SessionPage[] = [
      { id: 1, url: "https://a.example" },
      { id: 2, url: "https://b.example" },
    ];
    let clickCalls = 0;
    const session = createPageSession({
      pid: 132,
      pages,
      onTool: {
        take_snapshot: () =>
          snapshotResult(snapshotWithControls({ id: "uid-b", role: "button", name: "Run B" })),
        close_page: (call) => {
          const index = pages.findIndex((page) => page.id === call.arguments?.pageId);
          if (index >= 0) {
            pages.splice(index, 1);
          }
          return textResult("closed");
        },
        click: () => {
          clickCalls += 1;
          return textResult("clicked");
        },
      },
    });
    setChromeMcpSessionFactoryForTest(() => session);

    const oldTarget = (await listChromeMcpTabs("chrome-live"))[1]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot(targetFor(oldTarget));
    await closeChromeMcpTab("chrome-live", oldTarget);
    await expect(
      clickChromeMcpElement({
        ...targetFor(oldTarget),
        uid: snapshot.children?.[0]?.id ?? "",
      }),
    ).rejects.toThrow(/tab not found/i);
    expect(clickCalls).toBe(0);

    pages.push({ id: 2, url: "https://replacement.example" });
    const replacement = (await listChromeMcpTabs("chrome-live")).find(
      (tab) => tab.url === "https://replacement.example",
    );
    expect(replacement?.targetId).not.toBe(oldTarget);
  });

  it("names the configured endpoint when endpoint attach fails", async () => {
    setChromeMcpSessionFactoryForTest(() =>
      createPageSession({
        pid: 142,
        pages: [],
        onTool: { list_pages: () => textResult("Could not connect to Chrome: ECONNREFUSED", true) },
      }),
    );

    await expect(
      listChromeMcpTabs("chrome-live", {
        cdpUrl:
          "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      }),
    ).rejects.toThrow(
      /configured Chrome endpoint \(https:\/\/example\.com\/chrome\?token=\*\*\*\)/,
    );
  });

  it("fails closed for duplicate numeric page ids", async () => {
    setChromeMcpSessionFactoryForTest(() =>
      createPageSession({
        pid: 131,
        pages: [
          { id: 1, url: "https://a.example" },
          { id: 1, url: "https://b.example" },
        ],
      }),
    );

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/duplicate numeric page id 1/);
  });

  it("stops a session without waiting for a hung active operation", async () => {
    const pendingList = createDeferred<never>();
    const { promise: listStarted, resolve: markListStarted } = createDeferred<void>();
    const session = createPageSession({
      pid: 138,
      onTool: {
        list_pages: async () => {
          markListStarted();
          return await pendingList.promise;
        },
      },
    });
    const close = vi.fn(async () => {
      pendingList.reject(new Error("session closed by explicit stop"));
    });
    session.client.close = close as typeof session.client.close;
    setChromeMcpSessionFactoryForTest(() => session);

    const active = listChromeMcpTabs("chrome-live");
    const activeExpectation = expect(active).rejects.toThrow(/session closed by explicit stop/);
    await listStarted;

    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    await activeExpectation;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let work queued before stop recreate the session", async () => {
    const { promise: listStarted, resolve: markListStarted } = createDeferred<void>();
    const { promise: listGate, resolve: releaseList } = createDeferred<void>();
    let factoryCalls = 0;
    let listCalls = 0;
    setChromeMcpSessionFactoryForTest(() => {
      factoryCalls += 1;
      return createPageSession({
        pid: 139,
        onTool: {
          list_pages: async () => {
            listCalls += 1;
            if (listCalls === 1) {
              markListStarted();
              await listGate;
            }
          },
        },
      });
    });

    const active = listChromeMcpTabs("chrome-live");
    await listStarted;
    const queued = listChromeMcpTabs("chrome-live");
    const queuedExpectation = expect(queued).rejects.toThrow(/changed before the operation/);
    await setImmediate();

    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    releaseList();
    await active;
    await queuedExpectation;
    expect(factoryCalls).toBe(1);
    expect(listCalls).toBe(1);
  });

  it("fails queued work closed while a transport failure is closing", async () => {
    const { promise: listStarted, resolve: markListStarted } = createDeferred<void>();
    const { promise: listGate, resolve: releaseList } = createDeferred<void>();
    const { promise: closeStarted, resolve: markCloseStarted } = createDeferred<void>();
    const { promise: closeGate, resolve: releaseClose } = createDeferred<void>();
    const session = createPageSession({
      onTool: {
        list_pages: async () => {
          markListStarted();
          await listGate;
          throw new Error("transport failed before stop");
        },
      },
    });
    const close = vi.fn(async () => {
      markCloseStarted();
      await closeGate;
    });
    session.client.close = close as typeof session.client.close;
    setChromeMcpSessionFactoryForTest(() => session);

    const active = listChromeMcpTabs("chrome-live");
    void active.catch(() => {});
    await listStarted;
    const queued = listChromeMcpTabs("chrome-live");
    void queued.catch(() => {});
    releaseList();
    await closeStarted;

    let explicitCloseSettled = false;
    const explicitClose = closeChromeMcpSession("chrome-live").then((closed) => {
      explicitCloseSettled = true;
      return closed;
    });
    await setImmediate();
    expect(explicitCloseSettled).toBe(false);
    releaseClose();
    await expect(active).rejects.toThrow(/transport failed before stop/);
    await expect(queued).rejects.toThrow("changed before the operation could start");
    await expect(explicitClose).resolves.toBe(true);
  });

  it.each(["during admission", "while queued"])(
    "cancels %s without interrupting shared work",
    async (phase) => {
      const { promise: firstStarted, resolve: markFirstStarted } = createDeferred<void>();
      const { promise: firstGate, resolve: releaseFirst } = createDeferred<void>();
      let listCalls = 0;
      const session = createPageSession({
        pid: 138,
        onTool: {
          list_pages: async () => {
            listCalls += 1;
            if (listCalls === 1) {
              markFirstStarted();
              await firstGate;
            }
          },
        },
      });
      const factory = vi.fn(() => session);
      setChromeMcpSessionFactoryForTest(factory);

      const first = listChromeMcpTabs("chrome-live");
      await firstStarted;
      const close = vi.spyOn(session.client, "close");
      const ctrl = new AbortController();
      const aborted = listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal });
      const timedOut = listChromeMcpTabs("chrome-live", undefined, { timeoutMs: 20 });
      const abortedExpectation = expect(aborted).rejects.toThrow(/queued caller cancelled/);
      const timedOutExpectation = expect(timedOut).rejects.toThrow(
        /timed out after 20ms while waiting/,
      );
      if (phase === "while queued") {
        await setImmediate();
      }
      ctrl.abort(new Error("queued caller cancelled"));

      try {
        await abortedExpectation;
        await timedOutExpectation;
        expect(listCalls).toBe(1);
        expect(close).not.toHaveBeenCalled();
      } finally {
        releaseFirst();
        await first;
      }
      await setImmediate();
      expect(listCalls).toBe(1);
      await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(1);
      expect(factory).toHaveBeenCalledTimes(1);
    },
  );

  it("wraps snapshot refs and rejects stale or cross-target refs before dispatch", async () => {
    const clickedUids: unknown[] = [];
    const { targets } = await setupSnapshotSession(
      (call) => {
        if (call.name === "take_snapshot") {
          return snapshotResult(snapshotWithControls({ id: "1_2", role: "button", name: "Run" }));
        }
        if (call.name === "click") {
          clickedUids.push(call.arguments?.uid);
          return textResult("clicked");
        }
        return undefined;
      },
      [1, 2],
    );
    const targetA = targets[0]!;
    const targetB = targets[1]!;
    const first = await takeChromeMcpSnapshot(targetA);
    const firstRef = first.children?.[0]?.id;
    expect(firstRef).toMatch(/^mcp-ref:/);
    await clickChromeMcpElement({ ...targetA, uid: firstRef ?? "" });
    await expect(clickChromeMcpElement({ ...targetB, uid: firstRef ?? "" })).rejects.toThrow(
      /Run a new snapshot/,
    );

    const second = await takeChromeMcpSnapshot(targetA);
    const secondRef = second.children?.[0]?.id;
    expect(secondRef).not.toBe(firstRef);
    await expect(clickChromeMcpElement({ ...targetA, uid: firstRef ?? "" })).rejects.toThrow(
      /Run a new snapshot/,
    );
    await clickChromeMcpElement({ ...targetA, uid: secondRef ?? "" });
    expect(clickedUids).toEqual(["1_2", "1_2"]);
  });

  it("wraps deeply nested snapshot refs without recursive traversal", async () => {
    let root: ChromeMcpSnapshotNode = { id: "leaf", role: "text", name: "leaf" };
    for (let index = 0; index < 50_000; index += 1) {
      root = {
        id: `n${index}`,
        role: "generic",
        children: [root],
      };
    }
    root.role = "RootWebArea";
    const { targets } = await setupSnapshotSession((call) =>
      call.name === "take_snapshot" ? { structuredContent: { snapshot: root } } : undefined,
    );
    let node = await takeChromeMcpSnapshot(targets[0]!);
    let depth = 0;
    while (node.children?.[0]) {
      node = node.children[0];
      depth += 1;
    }
    expect(depth).toBe(50_000);
    expect(node.id).toMatch(/^mcp-ref:/);
  });

  it("unwraps current snapshot refs for every ref-scoped MCP adapter", async () => {
    const { session, targets } = await setupSnapshotSession(async (call) => {
      if (call.name === "take_snapshot") {
        return snapshotResult(
          snapshotWithControls(
            { id: "uid-a", role: "textbox", name: "A" },
            { id: "uid-b", role: "textbox", name: "B" },
          ),
        );
      }
      if (call.name === "take_screenshot") {
        await fs.writeFile(`${String(call.arguments?.filePath)}.png`, Buffer.from("png"));
        return textResult("saved");
      }
      if (["fill", "fill_form", "hover", "drag", "upload_file"].includes(call.name)) {
        return textResult("ok");
      }
      return undefined;
    });
    const target = targets[0]!;
    const snapshot = await takeChromeMcpSnapshot(target);
    const refA = snapshot.children?.[0]?.id ?? "";
    const refB = snapshot.children?.[1]?.id ?? "";
    const element = { ...target, uid: refA };

    await takeChromeMcpScreenshot(element);
    await fillChromeMcpElement({ ...element, value: "x" });
    await fillChromeMcpForm({
      ...target,
      elements: [
        { uid: refA, value: "x" },
        { uid: refB, value: "y" },
      ],
    });
    await hoverChromeMcpElement(element);
    await dragChromeMcpElement({ ...target, fromUid: refA, toUid: refB });
    await uploadChromeMcpFile({
      ...element,
      filePaths: ["/tmp/input.txt", "/tmp/attachment.txt"],
    });
    await evaluateChromeMcpScript({
      ...target,
      fn: "(a, b) => [a, b]",
      args: [refA, refB],
    });

    const calls = vi.spyOn(session.client, "callTool").mock.calls.map(([call]) => call);
    expect(Object.fromEntries(calls.map((call) => [call.name, call.arguments]))).toMatchObject({
      take_screenshot: { pageId: 1, uid: "uid-a" },
      fill: { pageId: 1, uid: "uid-a", value: "x" },
      fill_form: {
        pageId: 1,
        elements: [
          { uid: "uid-a", value: "x" },
          { uid: "uid-b", value: "y" },
        ],
      },
      hover: { pageId: 1, uid: "uid-a" },
      drag: { pageId: 1, from_uid: "uid-a", to_uid: "uid-b" },
      upload_file: {
        pageId: 1,
        uid: "uid-a",
        filePaths: ["/tmp/input.txt", "/tmp/attachment.txt"],
      },
      evaluate_script: { pageId: 1, args: ["uid-a", "uid-b"] },
    });
  });

  it("does not replay a mutation after its transport reports an uncertain outcome", async () => {
    let factoryCalls = 0;
    let clickCalls = 0;
    setChromeMcpSessionFactoryForTest(() => {
      factoryCalls += 1;
      return createPageSession({
        pid: 150 + factoryCalls,
        onTool: {
          take_snapshot: () =>
            snapshotResult(snapshotWithControls({ id: "1_2", role: "button", name: "Run" })),
          click: () => {
            clickCalls += 1;
            throw new Error("connection reset after dispatch");
          },
        },
      });
    });

    const targetId = (await listChromeMcpTabs("chrome-live"))[0]?.targetId ?? "";
    const snapshot = await takeChromeMcpSnapshot(targetFor(targetId));
    await expect(
      clickChromeMcpElement({
        ...targetFor(targetId),
        uid: snapshot.children?.[0]?.id ?? "",
      }),
    ).rejects.toThrow(/connection reset after dispatch/);
    expect(clickCalls).toBe(1);
    expect(factoryCalls).toBe(1);

    await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
  });

  it("reads jpeg screenshots and cleans their workspace", async () => {
    const session = createFakeSession();
    setChromeMcpSessionFactoryForTest(() => session);
    const result = takeChromeMcpScreenshot({
      ...fakeTarget,
      format: "jpeg",
    });
    await expect(result).resolves.toEqual(Buffer.from("screenshot:jpeg"));
    const filePath = vi
      .mocked(session.client)
      .callTool.mock.calls.find(([call]) => call.name === "take_screenshot")?.[0]
      .arguments?.filePath;
    if (typeof filePath !== "string") {
      throw new Error("screenshot path missing");
    }
    await expect(fs.stat(path.dirname(filePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["success", "failure"] as const)(
    "keeps a replacement attached after a retired session's late census %s",
    async (outcome) => {
      const first = createFakeSession();
      first.processCleanup = { status: "open" };
      const second = createPageSession({ pid: 456 });
      const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
      setChromeMcpSessionFactoryForTest(factory);
      const original = await getChromeMcpSessionOwner(
        "chrome-live",
        normalizeChromeMcpOptions(),
      ).lease({});
      const census = createDeferred<ReturnType<typeof processSnapshot>[]>();
      let scans = 0;
      let alive = true;
      let lateCleanup: Promise<void> | undefined;
      let replacement: typeof original | undefined;
      mockChromeMcpProcesses({
        platform: "linux",
        listProcesses: async () => {
          if (++scans === 2) {
            return await census.promise;
          }
          return alive ? [processSnapshot(123, 1)] : [];
        },
      });
      first.client.close = vi.fn(async () => {
        // Model a tools/list reply arriving while SDK close waits for its child to exit.
        lateCleanup ??= refreshChromeMcpCleanupProcess(first)
          .catch(() => {})
          .then(() => original.owner.close(first));
        alive = false;
        (first.transport as { pid: number | null }).pid = null;
      }) as typeof first.client.close;
      try {
        await closeChromeMcpSession("chrome-live");
        expect(first.processCleanup?.status).toBe("closed");
        replacement = await getChromeMcpSessionOwner(
          "chrome-live",
          normalizeChromeMcpOptions(),
        ).lease({});
        expect(getChromeMcpPid("chrome-live")).toBe(456);
        if (outcome === "failure") {
          census.reject(new Error("late process census failed"));
        } else {
          census.resolve([processSnapshot(123, 1)]);
        }
        await lateCleanup;
        expect(first.processCleanup?.status).toBe("closed");
        expect(getChromeMcpPid("chrome-live")).toBe(456);
        await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(1);
        expect(factory).toHaveBeenCalledTimes(2);
      } finally {
        census.resolve([]);
        await lateCleanup?.catch(() => {});
        first.processCleanup = { status: "closed" };
        await original.owner.close(first);
        if (replacement) {
          await replacement.owner.close(replacement.session);
        }
      }
    },
  );

  it("terminates the owned Chrome MCP subprocess tree when closing temporary sessions", async () => {
    const { closeMock } = installProcessSession();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([123, 124, 125]);
    mockCleanupProcesses({
      platform: "linux",
      listProcesses: vi.fn(async () =>
        [
          processSnapshot(123, 1),
          processSnapshot(124, 123),
          processSnapshot(125, 124),
          processSnapshot(126, 1),
        ].filter(({ pid }) => alive.has(pid)),
      ),
      killProcess: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === "SIGKILL") {
          alive.delete(pid);
        }
      },
    });

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(killCalls).toEqual([
      { pid: 125, signal: "SIGTERM" },
      { pid: 124, signal: "SIGTERM" },
      { pid: 123, signal: "SIGTERM" },
      { pid: 125, signal: "SIGKILL" },
      { pid: 124, signal: "SIGKILL" },
      { pid: 123, signal: "SIGKILL" },
    ]);
  });

  it("retains the proven root while skipping exited and reparented descendants", async () => {
    installProcessSession();
    const alive = new Set([123, 124, 125]);
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        alive.delete(pid);
      }
    });
    mockCleanupProcesses({
      platform: "linux",
      listProcesses: vi.fn(async () =>
        [
          processSnapshot(123, 1),
          // 124 reparented before the snapshot; 125 remains its child. An exited
          // child is simply absent. Neither can become owned through stale ancestry.
          processSnapshot(124, 999),
          processSnapshot(125, 124),
        ].filter(({ pid }) => alive.has(pid)),
      ),
      killProcess,
    });

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(killProcess).toHaveBeenCalledWith(123, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(123, "SIGKILL");
    expect(killProcess).not.toHaveBeenCalledWith(124, expect.anything());
    expect(killProcess).not.toHaveBeenCalledWith(125, expect.anything());
  });

  it("keeps snapshot uncertainty closed after the root disappears", async () => {
    const { session, closeMock, factory } = installProcessSession();
    const listProcesses = vi.fn().mockRejectedValue(new Error("process enumeration failed"));
    closeMock.mockImplementation(async () => {
      (session.transport as { pid: number | null }).pid = null;
    });
    mockCleanupProcesses({
      platform: "linux",
      listProcesses,
    });

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
    ).rejects.toThrow("process enumeration failed");
    expect(closeMock).toHaveBeenCalledOnce();
    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      "subprocess tree cleanup could not be verified",
    );
    expect(factory).toHaveBeenCalledOnce();

    (session.transport as { pid: number | null }).pid = 123;
    let alive = true;
    listProcesses.mockImplementation(async () => (alive ? [processSnapshot(123, 1)] : []));
    mockCleanupProcesses({
      platform: "linux",
      listProcesses,
      killProcess: (_pid, signal) => {
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
    });
    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
  });

  it("uses Windows taskkill tree cleanup without waiting for SDK stdio close timeout", async () => {
    const { closeMock } = installProcessSession();
    const closeOrder: string[] = [];
    let alive = true;
    closeMock.mockImplementation(async () => {
      closeOrder.push("client.close");
    });
    mockCleanupProcesses({
      platform: "win32",
      listProcesses: vi.fn(async () => (alive ? [processSnapshot(123, 1)] : [])),
      taskkillProcessTree: vi.fn(async (pid) => {
        closeOrder.push(`taskkill:${pid}`);
        alive = false;
      }),
    });

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(closeOrder).toEqual(["taskkill:123", "client.close"]);
  });

  it.each([false, true])(
    "retains failed Windows cleanup without killing a reused PID (reused=%s)",
    async (reused) => {
      const { session, closeMock } = installProcessSession();
      closeMock.mockImplementation(async () => {
        (session.transport as { pid: number | null }).pid = null;
      });
      let identity = "start-123";
      let alive = true;
      const taskkillProcessTree = vi.fn().mockRejectedValue(new Error("taskkill failed"));
      mockCleanupProcesses({
        platform: "win32",
        listProcesses: async () => (alive ? [processSnapshot(123, 1, identity)] : []),
        taskkillProcessTree,
      });
      await expect(
        ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
      ).rejects.toThrow("taskkill failed");
      expect(closeMock).toHaveBeenCalledOnce();
      if (reused) {
        identity = "start-reused";
      }
      taskkillProcessTree.mockImplementation(async () => {
        alive = false;
      });
      await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
      expect(taskkillProcessTree).toHaveBeenCalledTimes(reused ? 1 : 2);
      expect(taskkillProcessTree).toHaveBeenLastCalledWith(123);
      expect(alive).toBe(reused);
    },
  );

  it("never taskkills a descendant pid recycled while another Windows cleanup is awaited", async () => {
    const { session } = installProcessSession();
    Object.assign(session, {
      processCleanup: {
        status: "tracked",
        target: {
          root: { pid: 123, identity: "win32:start-123|fixture" },
          descendants: [
            { pid: 124, identity: "win32:start-124|fixture" },
            { pid: 125, identity: "win32:start-125|fixture" },
          ],
        },
      },
    });
    let firstDescendantAlive = true;
    let secondDescendantIdentity = "start-124";
    const taskkillProcessTree = vi.fn(async (pid: number) => {
      if (pid !== 125) {
        throw new Error("attempted to terminate a recycled pid");
      }
      firstDescendantAlive = false;
      secondDescendantIdentity = "start-reused";
    });
    mockCleanupProcesses({
      platform: "win32",
      listProcesses: async () => [
        processSnapshot(124, 1, secondDescendantIdentity),
        ...(firstDescendantAlive ? [processSnapshot(125, 1)] : []),
      ],
      taskkillProcessTree,
    });

    await ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true });

    expect(secondDescendantIdentity).toBe("start-reused");
    expect(taskkillProcessTree).toHaveBeenCalledExactlyOnceWith(125);
    expect(taskkillProcessTree).not.toHaveBeenCalledWith(124);
  });

  it("surfaces a surviving Chrome MCP process and retries its exact retained handle", async () => {
    const { session, closeMock, factory } = installProcessSession();
    closeMock.mockImplementation(async () => {
      (session.transport as { pid: number | null }).pid = null;
    });
    const killProcess = vi.fn();
    mockCleanupProcesses({
      platform: "linux",
      listProcesses: vi.fn().mockResolvedValue([processSnapshot(123, 1)]),
      killProcess,
    });

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true }),
    ).rejects.toThrow("cleanup failed for pid 123");
    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow("cleanup failed for pid 123");
    expect(factory).toHaveBeenCalledOnce();

    let alive = true;
    mockCleanupProcesses({
      platform: "linux",
      listProcesses: vi.fn(async () => (alive ? [processSnapshot(123, 1)] : [])),
      killProcess: (pid, signal) => {
        killProcess(pid, signal);
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
    });
    await expect(closeChromeMcpSession("chrome-live")).resolves.toBe(true);
    expect(closeMock).toHaveBeenCalledTimes(3);
  });

  it("preserves unrelated targets and refs when new_page returns only the created page", async () => {
    let clickedUid: unknown;
    const { session, targets } = await setupSnapshotSession((call) => {
      if (call.name === "take_snapshot") {
        return snapshotResult(snapshotWithControls({ id: "uid-a", role: "button", name: "Run A" }));
      }
      if (call.name === "new_page") {
        return pagesResult([{ id: 2, url: "about:blank", selected: true }]);
      }
      if (call.name === "click") {
        clickedUid = call.arguments?.uid;
        return textResult("clicked");
      }
      return undefined;
    });
    const target = targets[0]!;
    const snapshot = await takeChromeMcpSnapshot(target);
    await openChromeMcpTab("chrome-live", "about:blank");
    await clickChromeMcpElement({
      ...target,
      uid: snapshot.children?.[0]?.id ?? "",
    });

    expect(clickedUid).toBe("uid-a");
    const calls = vi.spyOn(session.client, "callTool").mock.calls.map(([call]) => call.name);
    expect(calls).toEqual(["list_pages", "take_snapshot", "list_pages", "new_page", "click"]);
  });

  it("uses native pointer input for coordinate clicks", async () => {
    const session = createFakeSession();
    const callTool = vi.fn(async ({ name }: ToolCall) => {
      if (name === "click_at") {
        return textResult("Successfully clicked at the coordinates");
      }
      throw new Error(`unexpected tool ${name}`);
    });
    session.client.callTool = callTool;
    setChromeMcpSessionFactoryForTest(() => session);

    await clickChromeMcpCoords({
      ...fakeTarget,
      x: 10,
      y: 20,
      doubleClick: true,
    });

    expect(callTool.mock.calls.map(([call]) => call)).toEqual([
      { name: "click_at", arguments: { pageId: 1, x: 10, y: 20, dblClick: true } },
    ]);
  });

  it("reports navigation failure when the last-page marker cannot be closed", async () => {
    const pages = [{ id: 1, url: "https://example.com", selected: true }];
    const session = createPageSession({
      pages,
      onTool: {
        new_page: () => {
          const page = { id: 2, url: "about:blank", selected: true };
          pages.push(page);
          return pagesResult([page]);
        },
        navigate_page: () => {
          pages.splice(0, 1);
          return {
            structuredContent: {
              message: "Unable to navigate in the selected page: net::ERR_CONNECTION_REFUSED.",
              pages,
            },
          };
        },
        close_page: () => ({
          structuredContent: {
            message: "The last open page cannot be closed. It is fine to keep it open.",
            pages,
          },
        }),
      },
    });
    setChromeMcpSessionFactoryForTest(() => session);
    await listChromeMcpTabs("chrome-live");
    await expect(openChromeMcpTab("chrome-live", "https://failed.example")).rejects.toMatchObject({
      message: "Failed to open a tracked Chrome MCP page and close its marker",
      errors: [
        expect.objectContaining({ message: expect.stringContaining("ERR_CONNECTION_REFUSED") }),
        expect.objectContaining({
          message: expect.stringContaining("The last open page cannot be closed"),
        }),
      ],
    });
    expect(await listChromeMcpTabs("chrome-live")).toEqual([
      expect.objectContaining({ url: "about:blank" }),
    ]);
  });

  it("does not poison the next real attach after an ephemeral no-page probe", async () => {
    const { factory, closeMocks } = installFakeSessions((session, call) => {
      if (call === 1) {
        const callTool = vi.fn(async ({ name }: ToolCall) => {
          if (name === "list_pages") {
            return textResult("No page selected", true);
          }
          throw new Error(`unexpected tool ${name}`);
        });
        session.client.callTool = callTool;
      }
    });

    await expect(
      listChromeMcpTabs("chrome-live", undefined, {
        ephemeral: true,
      }),
    ).rejects.toThrow(/No page selected/);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factory).toHaveBeenCalledTimes(2);
    expect(closeMocks[1]).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(2);
  });

  it("closes the exact session when the last waiter aborts during readiness", async () => {
    const ctrl = new AbortController();
    const { closeMocks } = installFakeSessions((session) => {
      session.ready = new Promise<void>(() => {});
      queueMicrotask(() => ctrl.abort(new Error("settlement cancelled")));
    });

    await expect(
      listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal }),
    ).rejects.toThrow("settlement cancelled");
    expect(closeMocks[0]).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "holds replacements behind canceled attach cleanup (ephemeral=%s)",
    async (ephemeral) => {
      const ready = createDeferred<void>();
      const closing = createDeferred<void>();
      const { factory, closeMocks } = installFakeSessions((session, call, close) => {
        if (call === 1) {
          session.ready = ready.promise;
          close.mockImplementation(async () => {
            await closing.promise;
          });
        }
      });
      const ctrl = new AbortController();
      const cancelled = listChromeMcpTabs("chrome-live", undefined, { signal: ctrl.signal });
      const rejected = expect(cancelled).rejects.toThrow("caller cancelled");
      await waitForChromeMcpState(() => expect(factory).toHaveBeenCalledTimes(1));
      ctrl.abort(new Error("caller cancelled"));
      if (ephemeral) {
        ready.resolve();
      }
      await waitForChromeMcpState(() => expect(closeMocks[0]).toHaveBeenCalledOnce());
      const replacement = ephemeral
        ? ensureChromeMcpAvailable("chrome-live", undefined, { ephemeral: true })
        : listChromeMcpTabs("chrome-live");
      await setImmediate();
      expect(factory).toHaveBeenCalledTimes(1);
      closing.resolve();
      await rejected;
      if (ephemeral) {
        await expect(replacement).resolves.toBeUndefined();
        expect(closeMocks[1]).toHaveBeenCalledOnce();
      } else {
        await expect(replacement).resolves.toHaveLength(2);
        expect(closeMocks[1]).not.toHaveBeenCalled();
      }
      expect(factory).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["abort", "timeout"])(
    "keeps a pending shared session when one waiter ends by %s",
    async (mode) => {
      const ready = createDeferred<void>();
      const readyThen = vi.spyOn(ready.promise, "then");
      const { factory, closeMocks } = installFakeSessions((session) => {
        session.ready = ready.promise;
      });
      const controller = new AbortController();
      const keptController = new AbortController();
      const first = listChromeMcpTabs(
        "chrome-live",
        undefined,
        mode === "abort" ? { signal: controller.signal } : { timeoutMs: 1 },
      );
      const rejection = expect(first).rejects.toThrow(
        mode === "abort" ? "first caller cancelled" : /timed out/,
      );
      if (mode === "abort") {
        await waitForChromeMcpState(() => expect(factory).toHaveBeenCalledTimes(1));
        await waitForChromeMcpState(() => expect(readyThen).toHaveBeenCalledTimes(1));
      }
      const kept = listChromeMcpTabs("chrome-live", undefined, { signal: keptController.signal });
      await waitForChromeMcpState(() => expect(factory).toHaveBeenCalledTimes(1));
      await waitForChromeMcpState(() => expect(readyThen).toHaveBeenCalledTimes(2));
      if (mode === "abort") {
        controller.abort(new Error("first caller cancelled"));
      } else {
        await rejection;
      }
      const later = mode === "timeout" ? listChromeMcpTabs("chrome-live") : undefined;
      ready.resolve();
      await rejection;
      await expect(kept).resolves.toHaveLength(2);
      await expect(later ?? listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(closeMocks[0]).not.toHaveBeenCalled();
      keptController.abort(new Error("kept waiter cancelled"));
    },
  );

  it("does not let ephemeral probes persist canceled pending attaches", async () => {
    const { promise: firstReadyGate, resolve: releaseFirstReady } = createDeferred<void>();
    const firstReadyThen = vi.spyOn(firstReadyGate, "then");

    const { factory, closeMocks } = installFakeSessions((session, call) => {
      if (call === 1) {
        session.ready = firstReadyGate;
      }
    });

    const ctrl = new AbortController();
    const firstAvailablePromise = ensureChromeMcpAvailable("chrome-live", undefined, {
      signal: ctrl.signal,
    });
    const firstAvailableExpectation =
      expect(firstAvailablePromise).rejects.toThrow(/first waiter cancelled/);

    await waitForChromeMcpState(() => expect(factory).toHaveBeenCalledTimes(1));
    await waitForChromeMcpState(() => expect(firstReadyThen).toHaveBeenCalledTimes(1));

    await expect(
      ensureChromeMcpAvailable("chrome-live", undefined, {
        ephemeral: true,
      }),
    ).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstReadyThen).toHaveBeenCalledTimes(1);
    await waitForChromeMcpState(() => expect(closeMocks[1]).toHaveBeenCalledTimes(1));

    ctrl.abort(new Error("first waiter cancelled"));
    releaseFirstReady();
    await firstAvailableExpectation;
    await waitForChromeMcpState(() => expect(closeMocks[0]).toHaveBeenCalledTimes(1));

    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("cancels a stuck evaluate through the SDK signal and reconnects", async () => {
    let forwardedSignal: AbortSignal | undefined;
    const { promise: toolStarted, resolve: notifyToolStarted } = createDeferred<void>();
    const { factory } = installFakeSessions((session, call) => {
      if (call === 1) {
        session.client.callTool = vi.fn(
          async (_call: ToolCall, options?: { signal?: AbortSignal }) =>
            await new Promise((_resolve, reject) => {
              const signal = options?.signal;
              forwardedSignal = signal;
              notifyToolStarted();
              signal?.addEventListener(
                "abort",
                () => {
                  reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
                },
                {
                  once: true,
                },
              );
            }),
        ) as typeof session.client.callTool;
      }
    });
    const ctrl = new AbortController();
    const evaluatePromise = evaluateChromeMcpScript({
      ...fakeTarget,
      fn: "() => window.location.href",
      signal: ctrl.signal,
    });

    await toolStarted;
    expect(forwardedSignal).toBe(ctrl.signal);
    ctrl.abort(new Error("target browser crashed"));

    await expect(evaluatePromise).rejects.toThrow(/target browser crashed/i);
    await expect(listChromeMcpTabs("chrome-live")).resolves.toHaveLength(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh session when userDataDir changes for the same profile", async () => {
    const { factory, closeMocks } = installFakeSessions(() => {});

    await listChromeMcpTabs("chrome-live", { userDataDir: "/tmp/brave-a" });
    await listChromeMcpTabs("chrome-live", { userDataDir: "/tmp/brave-b" });

    expect(
      factory.mock.calls.map(([profileName, options]) => ({
        profileName,
        userDataDir: options?.userDataDir,
      })),
    ).toEqual([
      { profileName: "chrome-live", userDataDir: "/tmp/brave-a" },
      { profileName: "chrome-live", userDataDir: "/tmp/brave-b" },
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("clears cached sessions after repeated stale selected-page failures", async () => {
    const { factory } = installFakeSessions((session) => {
      session.client.callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name !== "list_pages") {
          throw new Error(`unexpected tool ${name}`);
        }
        if (factory.mock.calls.length <= 2) {
          return textResult(
            "The selected page has been closed. Call list_pages to see open pages.",
            true,
          );
        }
        return fakeListPagesResult();
      });
    });

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(
      /The selected page has been closed/,
    );

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(factory).toHaveBeenCalledTimes(3);
    expect(tabs).toHaveLength(1);
  });

  it("caps the navigation timeout before adding SDK watchdog grace", async () => {
    const session = createFakeSession();
    setChromeMcpSessionFactoryForTest(() => session);

    await navigateChromeMcpPage({
      ...fakeTarget,
      url: "https://example.com",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    const navigateCall = vi
      .spyOn(session.client, "callTool")
      .mock.calls.find(([call]) => call.name === "navigate_page");
    expect(navigateCall).toMatchObject([{ arguments: { timeout: 120_000 } }, { timeout: 125_000 }]);
  });

  it("resets the Chrome MCP session when a navigate_page call hangs past the safety-net timeout", async () => {
    vi.useFakeTimers();
    const { factory } = installFakeSessions((session, invocation) => {
      if (invocation === 1) {
        session.client.callTool = vi.fn(async (call: ToolCall, options?: { timeout?: number }) => {
          if (call.name === "list_pages") {
            return fakeListPagesResult();
          }
          expect(call.arguments?.timeout).toBe(20_000);
          expect(options?.timeout).toBe(25_000);
          return await new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")),
              options?.timeout,
            );
          });
        });
      }
    });

    const navPromise = navigateChromeMcpPage({
      ...fakeTarget,
      url: "https://slow-site.example",
    });
    // Suppress unhandled-rejection detection: navPromise rejects during timer
    // advancement, before the expect below attaches its handler.
    void navPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(25_001);

    await expect(navPromise).rejects.toThrow(/Chrome MCP "navigate_page".*timed out/);

    vi.useRealTimers();

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(tabs).toHaveLength(2);
  });

  it("redacts home-relative profile labels from availability timeout diagnostics", async () => {
    vi.useFakeTimers();
    const { closeMocks } = installFakeSessions((session) => {
      session.ready = new Promise<void>(() => {});
    });

    const homeDir = os.homedir();
    const profileName = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
    const promise = ensureChromeMcpAvailable(profileName, undefined, {
      ephemeral: true,
      timeoutMs: 50,
    });
    void promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).rejects.toThrow(/timed out after 50ms/i);
    await expect(promise).rejects.toThrow("~/Library/Application Support/Google/Chrome");
    await expect(promise).rejects.not.toThrow(homeDir);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);
  });
});

async function setupSnapshotSession(
  onTool: Parameters<typeof createPageSession>[0]["onTool"],
  pageIds = [1],
) {
  const session = createPageSession({
    pages: pageIds.map((id) => ({ id, url: `https://page-${id}.example` })),
    onTool,
  });
  setChromeMcpSessionFactoryForTest(() => session);
  const targets = (await listChromeMcpTabs("chrome-live")).map((tab) => targetFor(tab.targetId));
  return { session, targets };
}

function snapshotResult(snapshot: ChromeMcpSnapshotNode) {
  return { structuredContent: { snapshot } };
}

function buttonDocument(suffix = "", name?: string): ChromeMcpSnapshotNode {
  return {
    id: `root${suffix}`,
    role: "RootWebArea",
    children: [{ id: `button${suffix}`, role: "button", ...(name ? { name } : {}) }],
  };
}

describe("Chrome MCP snapshot identity and lifetime", () => {
  installChromeMcpSessionTestHooks();

  it("retires target refs before a failed snapshot refresh", async () => {
    let refreshing = false;
    let oldRef = "";
    const refPresentAtDispatch: boolean[] = [];
    const clicks: unknown[] = [];
    const { session, targets } = await setupSnapshotSession(
      {
        take_snapshot: (call) => {
          const pageId = call.arguments?.pageId;
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          if (refreshing) {
            refPresentAtDispatch.push(
              session.routing!.snapshotsByTarget.get(target.targetId)?.refs.has(oldRef) ?? false,
            );
            return textResult("snapshot failed after refresh", true);
          }
          return snapshotResult(buttonDocument(`-${pageId}`, "Run"));
        },
        click: (call) => {
          clicks.push([call.arguments?.pageId, call.arguments?.uid]);
          return { content: [] };
        },
      },
      [1, 2],
    );
    const target = targets[0]!;
    const sibling = targets[1]!;
    oldRef = (await takeChromeMcpSnapshot(target)).children![0]!.id!;
    const siblingRef = (await takeChromeMcpSnapshot(sibling)).children![0]!.id!;
    refreshing = true;
    const refresh = takeChromeMcpSnapshot(target);
    await expect(refresh).rejects.toThrow("snapshot failed after refresh");
    expect(refPresentAtDispatch).toEqual([false]);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);
    await clickChromeMcpElement({ ...sibling, uid: siblingRef });
    expect(clicks).toEqual([[2, "button-2"]]);
  });

  it("recaptures an expired document without retiring healthy sibling refs", async () => {
    const snapshots: number[] = [];
    const evaluatedUids: unknown[] = [];
    const clicks: unknown[] = [];
    let navigated = false;
    const { targets } = await setupSnapshotSession(
      {
        take_snapshot: (call) => {
          const pageId = call.arguments?.pageId;
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          snapshots.push(pageId);
          const documentId = pageId === 1 && navigated ? "new" : "initial";
          return snapshotResult(buttonDocument(`-${pageId}-${documentId}`));
        },
        evaluate_script: (call) => {
          const args = call.arguments?.args;
          evaluatedUids.push(args);
          if (navigated && Array.isArray(args) && args[0] === "root-1-initial") {
            return textResult(
              "Element with uid root-1-initial no longer exists on the page.",
              true,
            );
          }
          return textResult("```json\ntrue\n```");
        },
        click: (call) => {
          clicks.push([call.arguments?.pageId, call.arguments?.uid]);
          return { content: [] };
        },
      },
      [1, 2],
    );
    const target = targets[0]!;
    const sibling = targets[1]!;
    const oldRef = (await takeChromeMcpSnapshot(target)).children![0]!.id!;
    const siblingRef = (await takeChromeMcpSnapshot(sibling)).children![0]!.id!;
    navigated = true;

    await expect(
      withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
    ).rejects.toBeInstanceOf(ChromeMcpDocumentUnavailableError);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);
    await clickChromeMcpElement({ ...sibling, uid: siblingRef });
    await expect(
      withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
    ).resolves.toBe(true);
    await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(/Unknown ref/);

    expect(snapshots).toEqual([1, 2, 1]);
    expect(evaluatedUids).toEqual([["root-1-initial"], ["root-1-new"]]);
    expect(clicks).toEqual([[2, "button-2-initial"]]);
  });

  it.each([true, false])(
    "discards invalid snapshots without admitting inspection (ambiguous refs=%s)",
    async (ambiguous) => {
      let snapshots = 0;
      const { session, targets } = await setupSnapshotSession({
        take_snapshot: () => {
          if (++snapshots > 1) {
            return snapshotResult({ ...buttonDocument(), id: "valid-root" });
          }
          return snapshotResult(
            ambiguous
              ? snapshotWithControls(
                  { id: "button", role: "button", name: "Run" },
                  { id: "frame", role: "Iframe", children: [{ id: "button", role: "button" }] },
                )
              : { role: "RootWebArea", children: [{ id: "button", role: "button" }] },
          );
        },
        evaluate_script: () => textResult(ambiguous ? "```json\nnull\n```" : "```json\ntrue\n```"),
      });
      const target = targets[0]!;
      const inspect = vi.fn(async () => true);
      await expect(withChromeMcpDocument(target, inspect)).rejects.toThrow(
        ambiguous
          ? /ambiguous element IDs.*managed browser profile/
          : "Chrome MCP snapshot did not contain a top-level document uid",
      );
      expect(inspect).not.toHaveBeenCalled();
      expect(session.routing!.snapshotsByTarget.has(target.targetId)).toBe(false);
      if (ambiguous) {
        await expect(evaluateChromeMcpScript({ ...target, fn: "() => null" })).resolves.toBeNull();
      } else {
        await expect(
          withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
        ).resolves.toBe(true);
        expect(snapshots).toBe(2);
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
