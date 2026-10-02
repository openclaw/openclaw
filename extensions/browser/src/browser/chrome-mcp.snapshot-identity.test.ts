import { describe, expect, it, vi } from "vitest";
// Route tests mock the public facade in shared workers; exercise the real owners here.
import {
  clickChromeMcpElement,
  evaluateChromeMcpScript,
  takeChromeMcpSnapshot,
  withChromeMcpDocument,
} from "./chrome-mcp-actions.js";
import { ChromeMcpDocumentUnavailableError } from "./chrome-mcp-contracts.js";
import { setChromeMcpSessionFactoryForTest } from "./chrome-mcp-session.js";
import { listChromeMcpTabs } from "./chrome-mcp-tabs.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import {
  createPageSession,
  installChromeMcpSessionTestHooks,
  type ToolCall,
} from "./chrome-mcp.test-support.js";

async function setupSnapshotSession(onTool: (call: ToolCall) => unknown, pageIds = [1]) {
  const session = createPageSession({
    pid: 141,
    pages: pageIds.map((id) => ({ id, url: `https://page-${id}.example` })),
    onTool,
  });
  setChromeMcpSessionFactoryForTest(async () => session);
  const targets = (await listChromeMcpTabs("chrome-live")).map((tab) => ({
    profileName: "chrome-live",
    targetId: tab.targetId,
  }));
  return { session, targets };
}

function snapshotResult(snapshot: ChromeMcpSnapshotNode) {
  return { structuredContent: { snapshot } };
}

describe("Chrome MCP snapshot identity and lifetime", () => {
  installChromeMcpSessionTestHooks();

  it.each([
    {
      label: "different document roots",
      operation: "snapshot",
      child: {
        id: "child-root",
        role: "RootWebArea",
        children: [{ id: "button", role: "button" }],
      },
    },
    {
      label: "an omitted document root",
      operation: "document",
      child: { id: "button", role: "button" },
    },
  ])("rejects ambiguous $operation refs across $label", async ({ child, operation }) => {
    let root: ChromeMcpSnapshotNode = {
      id: "root",
      role: "RootWebArea",
      children: [{ id: "button", role: "button", name: "Run" }],
    };
    const clicks: unknown[] = [];
    const { session, targets } = await setupSnapshotSession((call) => {
      if (call.name === "take_snapshot") {
        return snapshotResult(root);
      }
      if (call.name === "click") {
        clicks.push(call.arguments?.uid);
        return { content: [] };
      }
      return undefined;
    });
    const target = targets[0]!;
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
    const { targets } = await setupSnapshotSession((call) =>
      call.name === "take_snapshot"
        ? snapshotResult({
            id: "root",
            role: "RootWebArea",
            children: [
              { id: "button", role: "button" },
              { role: "group", children: [{ id: "button", role: "button" }] },
            ],
          })
        : undefined,
    );
    const snapshot = await takeChromeMcpSnapshot(targets[0]!);
    expect(snapshot.children![0]!.id).toMatch(/^mcp-ref:/);
    expect(snapshot.children![0]!.id).toBe(snapshot.children![1]!.children![0]!.id);
  });

  it("retires target refs before a failed snapshot refresh", async () => {
    let refreshing = false;
    let oldRef = "";
    const refPresentAtDispatch: boolean[] = [];
    const clicks: unknown[] = [];
    const { session, targets } = await setupSnapshotSession(
      (call) => {
        const pageId = call.arguments?.pageId;
        if (call.name === "take_snapshot") {
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          if (refreshing) {
            refPresentAtDispatch.push(
              session.routing!.snapshotsByTarget.get(target.targetId)?.refs.has(oldRef) ?? false,
            );
            return {
              isError: true,
              content: [{ type: "text", text: "snapshot failed after refresh" }],
            };
          }
          return snapshotResult({
            id: `root-${pageId}`,
            role: "RootWebArea",
            children: [{ id: `button-${pageId}`, role: "button", name: "Run" }],
          });
        }
        if (call.name === "click") {
          clicks.push([pageId, call.arguments?.uid]);
          return { content: [] };
        }
        return undefined;
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

  it("preserves refs when a document probe's predicate throws", async () => {
    let snapshots = 0;
    const clicks: unknown[] = [];
    const { targets } = await setupSnapshotSession((call) => {
      if (call.name === "take_snapshot") {
        snapshots += 1;
        return snapshotResult({
          id: `root-${snapshots}`,
          role: "RootWebArea",
          children: [{ id: `button-${snapshots}`, role: "button" }],
        });
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
    });
    const target = targets[0]!;
    const initial = await takeChromeMcpSnapshot(target);
    const oldRef = initial.children![0]!.id!;
    const predicateError = new Error("Execution context was destroyed");
    const inspect = async () =>
      await withChromeMcpDocument(target, async (document) => {
        await document.evaluate("() => true");
        throw predicateError;
      });
    await expect(inspect()).rejects.toBe(predicateError);
    await clickChromeMcpElement({ ...target, uid: oldRef });
    expect(clicks).toEqual(["button-1"]);
    expect(snapshots).toBe(1);
  });

  it("recaptures an expired document without retiring healthy sibling refs", async () => {
    const snapshots: number[] = [];
    const evaluatedUids: unknown[] = [];
    const clicks: unknown[] = [];
    let navigated = false;
    const { targets } = await setupSnapshotSession(
      (call) => {
        const pageId = call.arguments?.pageId;
        if (call.name === "take_snapshot") {
          if (typeof pageId !== "number") {
            throw new Error("Snapshot requires a numeric pageId");
          }
          snapshots.push(pageId);
          const documentId = pageId === 1 && navigated ? "new" : "initial";
          return snapshotResult({
            id: `root-${pageId}-${documentId}`,
            role: "RootWebArea",
            children: [{ id: `button-${pageId}-${documentId}`, role: "button" }],
          });
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

  it("recovers when the document changes during a cold snapshot", async () => {
    let snapshots = 0;
    const { targets } = await setupSnapshotSession((call) => {
      if (call.name === "take_snapshot") {
        snapshots += 1;
        return snapshots === 1
          ? {
              isError: true,
              content: [{ type: "text", text: "Snapshot document changed. Take a new snapshot." }],
            }
          : snapshotResult({ id: "root", role: "RootWebArea" });
      }
      if (call.name === "evaluate_script") {
        return { content: [{ type: "text", text: "```json\ntrue\n```" }] };
      }
      return undefined;
    });
    const target = targets[0]!;
    const inspect = vi.fn(async (document: { evaluate: (fn: string) => Promise<unknown> }) =>
      document.evaluate("() => true"),
    );

    await expect(withChromeMcpDocument(target, inspect)).rejects.toBeInstanceOf(
      ChromeMcpDocumentUnavailableError,
    );
    expect(inspect).not.toHaveBeenCalled();
    await expect(withChromeMcpDocument(target, inspect)).resolves.toBe(true);
    expect(snapshots).toBe(2);
  });

  it.each([{ id: "not-a-document", role: "group" }, { role: "RootWebArea" }])(
    "does not publish refs from a cold snapshot without a document UID: %j",
    async (root) => {
      let snapshots = 0;
      const { session, targets } = await setupSnapshotSession((call) => {
        if (call.name === "take_snapshot") {
          snapshots += 1;
          return snapshotResult({
            ...(snapshots === 1 ? root : { id: "valid-root", role: "RootWebArea" }),
            children: [{ id: "button", role: "button" }],
          });
        }
        if (call.name === "evaluate_script") {
          return { content: [{ type: "text", text: "```json\ntrue\n```" }] };
        }
        return undefined;
      });
      const target = targets[0]!;
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
