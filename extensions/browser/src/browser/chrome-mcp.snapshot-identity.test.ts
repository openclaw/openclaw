import { describe, expect, it, vi } from "vitest";
import {
  ChromeMcpDocumentUnavailableError,
  clickChromeMcpElement,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  setChromeMcpSessionFactoryForTest,
  takeChromeMcpSnapshot,
  withChromeMcpDocument,
} from "./chrome-mcp.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import { createPageSession, installChromeMcpSessionTestHooks } from "./chrome-mcp.test-support.js";

describe("Chrome MCP snapshot identity and lifetime", () => {
  installChromeMcpSessionTestHooks();

  it.each(
    [
      {
        label: "different document roots",
        child: {
          id: "child-root",
          role: "RootWebArea",
          children: [{ id: "button", role: "button" }],
        },
      },
      {
        label: "colliding document roots",
        child: {
          id: "root",
          role: "RootWebArea",
          children: [{ id: "child-button", role: "button" }],
        },
      },
      { label: "an omitted document root", child: { id: "button", role: "button" } },
    ].flatMap((fixture) =>
      ["snapshot", "document"].map((operation) => ({
        label: fixture.label,
        child: fixture.child,
        operation,
      })),
    ),
  )("rejects ambiguous $operation refs across $label", async ({ child, operation }) => {
    let root: ChromeMcpSnapshotNode = {
      id: "root",
      role: "RootWebArea",
      children: [{ id: "button", role: "button", name: "Run" }],
    };
    const clicks: unknown[] = [];
    const session = createPageSession({
      pid: 141,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: (call) => {
        if (call.name === "take_snapshot") {
          return { structuredContent: { snapshot: root } };
        }
        if (call.name === "click") {
          clicks.push(call.arguments?.uid);
          return { content: [] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const [tab] = await listChromeMcpTabs("chrome-live");
    const target = { profileName: "chrome-live", targetId: tab!.targetId };
    const initial = operation === "snapshot" ? await takeChromeMcpSnapshot(target) : undefined;
    const oldRef = initial?.children?.[0]?.id;
    root = {
      ...root,
      children: [...root.children!, { id: "frame", role: "Iframe", children: [child] }],
    };
    const inspect = vi.fn(async () => "must not run");
    await expect(
      operation === "snapshot"
        ? takeChromeMcpSnapshot(target)
        : withChromeMcpDocument(target, inspect),
    ).rejects.toThrow(/ambiguous element IDs.*managed browser profile/);
    expect(inspect).not.toHaveBeenCalled();
    expect(session.routing!.snapshotsByTarget.has(target.targetId)).toBe(false);
    if (oldRef) {
      await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(
        /Unknown ref/,
      );
    }
    expect(clicks).toEqual([]);
    await expect(evaluateChromeMcpScript({ ...target, fn: "() => null" })).resolves.toBeNull();
  });

  it("preserves repeated UID aliases inside one document", async () => {
    const session = createPageSession({
      pid: 141,
      pages: [{ id: 1, url: "https://a.example" }],
      onTool: (call) =>
        call.name === "take_snapshot"
          ? {
              structuredContent: {
                snapshot: {
                  id: "root",
                  role: "RootWebArea",
                  children: [
                    { id: "button", role: "button" },
                    { role: "group", children: [{ id: "button", role: "button" }] },
                  ],
                },
              },
            }
          : undefined,
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const [tab] = await listChromeMcpTabs("chrome-live");
    const snapshot = await takeChromeMcpSnapshot({
      profileName: "chrome-live",
      targetId: tab!.targetId,
    });
    expect(snapshot.children![0]!.id).toMatch(/^mcp-ref:/);
    expect(snapshot.children![0]!.id).toBe(snapshot.children![1]!.children![0]!.id);
  });

  it.each([false, true])(
    "retires target refs before snapshot refresh, including failure=%s",
    async (fails) => {
      let refreshing = false;
      let oldRef = "";
      const refPresentAtDispatch: boolean[] = [];
      const clicks: unknown[] = [];
      const session = createPageSession({
        pid: 141,
        pages: [
          { id: 1, url: "https://a.example" },
          { id: 2, url: "https://b.example" },
        ],
        onTool: (call) => {
          const pageId = call.arguments?.pageId;
          if (call.name === "take_snapshot") {
            if (typeof pageId !== "number") {
              throw new Error("Snapshot requires a numeric pageId");
            }
            if (refreshing) {
              refPresentAtDispatch.push(
                session.routing!.snapshotsByTarget.get(target.targetId)?.refs.has(oldRef) ?? false,
              );
              if (fails) {
                return {
                  isError: true,
                  content: [{ type: "text", text: "snapshot failed after refresh" }],
                };
              }
            }
            return {
              structuredContent: {
                snapshot: {
                  id: `root-${pageId}`,
                  role: "RootWebArea",
                  children: [{ id: `button-${pageId}`, role: "button", name: "Run" }],
                },
              },
            };
          }
          if (call.name === "click") {
            clicks.push([pageId, call.arguments?.uid]);
            return { content: [] };
          }
          return undefined;
        },
      });
      setChromeMcpSessionFactoryForTest(async () => session);
      const tabs = await listChromeMcpTabs("chrome-live");
      const target = { profileName: "chrome-live", targetId: tabs[0]!.targetId };
      const sibling = { profileName: "chrome-live", targetId: tabs[1]!.targetId };
      oldRef = (await takeChromeMcpSnapshot(target)).children![0]!.id!;
      const siblingRef = (await takeChromeMcpSnapshot(sibling)).children![0]!.id!;
      refreshing = true;
      const refresh = takeChromeMcpSnapshot(target);
      if (fails) {
        await expect(refresh).rejects.toThrow("snapshot failed after refresh");
      } else {
        await refresh;
      }
      expect(refPresentAtDispatch).toEqual([false]);
      await expect(clickChromeMcpElement({ ...target, uid: oldRef })).rejects.toThrow(
        /Unknown ref/,
      );
      await clickChromeMcpElement({ ...sibling, uid: siblingRef });
      expect(clicks).toEqual([[2, "button-2"]]);
    },
  );

  it.each([undefined, "predicate failed", "Execution context was destroyed"])(
    "preserves refs across document probes with predicate error %s",
    async (errorMessage) => {
      let snapshots = 0;
      const clicks: unknown[] = [];
      const session = createPageSession({
        pid: 141,
        pages: [{ id: 1, url: "https://a.example" }],
        onTool: (call) => {
          if (call.name === "take_snapshot") {
            snapshots += 1;
            return {
              structuredContent: {
                snapshot: {
                  id: `root-${snapshots}`,
                  role: "RootWebArea",
                  children: [{ id: `button-${snapshots}`, role: "button" }],
                },
              },
            };
          }
          if (call.name === "evaluate_script") {
            expect(call.arguments).toMatchObject({ args: ["root-1"], waitForStableDom: false });
            return { content: [{ type: "text", text: "```json\ntrue\n```" }] };
          }
          if (call.name === "click") {
            clicks.push(call.arguments?.uid);
            return { content: [] };
          }
          return undefined;
        },
      });
      setChromeMcpSessionFactoryForTest(async () => session);
      const [tab] = await listChromeMcpTabs("chrome-live");
      const target = { profileName: "chrome-live", targetId: tab!.targetId };
      const initial = await takeChromeMcpSnapshot(target);
      const oldRef = initial.children![0]!.id!;
      const predicateError = errorMessage ? new Error(errorMessage) : undefined;
      const inspect = async () =>
        await withChromeMcpDocument(target, async (document) => {
          await document.evaluate("() => true");
          if (predicateError) {
            throw predicateError;
          }
          return true;
        });
      if (predicateError) {
        await expect(inspect()).rejects.toBe(predicateError);
      } else {
        await expect(inspect()).resolves.toBe(true);
        await expect(inspect()).resolves.toBe(true);
      }
      await clickChromeMcpElement({ ...target, uid: oldRef });
      expect(clicks).toEqual(["button-1"]);
      expect(snapshots).toBe(1);
    },
  );

  it("recaptures an expired document without retiring healthy sibling refs", async () => {
    const snapshots: number[] = [];
    const evaluatedUids: unknown[] = [];
    const clicks: unknown[] = [];
    let navigated = false;
    const session = createPageSession({
      pid: 141,
      pages: [
        { id: 1, url: "https://a.example" },
        { id: 2, url: "https://b.example" },
      ],
      onTool: (call) => {
        const pageId = call.arguments?.pageId;
        if (call.name === "take_snapshot") {
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          snapshots.push(pageId);
          const documentId = pageId === 1 && navigated ? "new" : "initial";
          return {
            structuredContent: {
              snapshot: {
                id: `root-${pageId}-${documentId}`,
                role: "RootWebArea",
                children: [{ id: `button-${pageId}-${documentId}`, role: "button" }],
              },
            },
          };
        }
        if (call.name === "evaluate_script") {
          const args = call.arguments?.args;
          evaluatedUids.push(args);
          if (navigated && Array.isArray(args) && args[0] === "root-1-initial") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Element with uid root-1-initial no longer exists on the page.",
                },
              ],
            };
          }
          return { content: [{ type: "text", text: "```json\ntrue\n```" }] };
        }
        if (call.name === "click") {
          clicks.push([pageId, call.arguments?.uid]);
          return { content: [] };
        }
        return undefined;
      },
    });
    setChromeMcpSessionFactoryForTest(async () => session);
    const tabs = await listChromeMcpTabs("chrome-live");
    const target = { profileName: "chrome-live", targetId: tabs[0]!.targetId };
    const sibling = { profileName: "chrome-live", targetId: tabs[1]!.targetId };
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

  it.each(["changed", "disappeared"])(
    "recovers when the document %s during a cold snapshot",
    async (change) => {
      let snapshots = 0;
      const session = createPageSession({
        pid: 141,
        pages: [{ id: 1, url: "https://a.example" }],
        onTool: (call) => {
          if (call.name === "take_snapshot") {
            snapshots += 1;
            return snapshots === 1
              ? {
                  isError: true,
                  content: [
                    { type: "text", text: `Snapshot document ${change}. Take a new snapshot.` },
                  ],
                }
              : { structuredContent: { snapshot: { id: "root", role: "RootWebArea" } } };
          }
          if (call.name === "evaluate_script") {
            return { content: [{ type: "text", text: "```json\ntrue\n```" }] };
          }
          return undefined;
        },
      });
      setChromeMcpSessionFactoryForTest(async () => session);
      const [tab] = await listChromeMcpTabs("chrome-live");
      const target = { profileName: "chrome-live", targetId: tab!.targetId };
      const inspect = vi.fn(async (document: { evaluate: (fn: string) => Promise<unknown> }) =>
        document.evaluate("() => true"),
      );

      await expect(withChromeMcpDocument(target, inspect)).rejects.toBeInstanceOf(
        ChromeMcpDocumentUnavailableError,
      );
      expect(inspect).not.toHaveBeenCalled();
      await expect(withChromeMcpDocument(target, inspect)).resolves.toBe(true);
      expect(snapshots).toBe(2);
    },
  );

  it.each([{ id: "not-a-document", role: "group" }, { role: "RootWebArea" }])(
    "does not publish refs from a cold snapshot without a document UID: %j",
    async (root) => {
      let snapshots = 0;
      const session = createPageSession({
        pid: 141,
        pages: [{ id: 1, url: "https://a.example" }],
        onTool: (call) => {
          if (call.name === "take_snapshot") {
            snapshots += 1;
            return {
              structuredContent: {
                snapshot: {
                  ...(snapshots === 1 ? root : { id: "valid-root", role: "RootWebArea" }),
                  children: [{ id: "button", role: "button" }],
                },
              },
            };
          }
          if (call.name === "evaluate_script") {
            return { content: [{ type: "text", text: "```json\ntrue\n```" }] };
          }
          return undefined;
        },
      });
      setChromeMcpSessionFactoryForTest(async () => session);
      const [tab] = await listChromeMcpTabs("chrome-live");
      const target = { profileName: "chrome-live", targetId: tab!.targetId };
      const inspect = vi.fn(async () => true);

      await expect(withChromeMcpDocument(target, inspect)).rejects.toThrow(
        "Chrome MCP snapshot did not contain a top-level document uid",
      );
      expect(inspect).not.toHaveBeenCalled();
      expect(session.routing!.snapshotsByTarget.has(target.targetId)).toBe(false);
      await expect(
        withChromeMcpDocument(target, (document) => document.evaluate("() => true")),
      ).resolves.toBe(true);
      expect(snapshots).toBe(2);
    },
  );
});
