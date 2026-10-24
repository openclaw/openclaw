import fs from "node:fs/promises";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { withTempDownloadPath } from "openclaw/plugin-sdk/temp-path";
import { resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import {
  rethrowChromeMcpDocumentError,
  ChromeMcpDocumentUnavailableError,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
  type ChromeMcpStructuredPage,
  type ChromeMcpTargetOperation,
} from "./chrome-mcp-contracts.js";
import { extractJsonMessage } from "./chrome-mcp-result.js";
import {
  callTargetTool,
  getChromeMcpRoutingState,
  resolveChromeMcpSnapshotRef,
  registerChromeMcpSnapshot,
  withChromeMcpTarget,
  type ChromeMcpPinnedTarget,
} from "./chrome-mcp-routing.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";

export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  await callTargetTool(
    {
      profileName,
      profile: profileOptions,
      targetId,
      ...options,
    },
    "select_page",
    { bringToFront: true },
  );
}

export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  await withChromeMcpTarget(
    {
      profileName,
      profile: profileOptions,
      targetId,
      ...options,
    },
    async (target) => {
      await target.callTool("close_page", { pageId: target.pageId });
      // Retire inside the same operation lock so queued work cannot dispatch
      // against a closed page id. A later list gets a new opaque handle even if
      // Chrome reuses that numeric id.
      const routing = getChromeMcpRoutingState(target.session);
      routing.targetIdByPageId.delete(target.pageId);
      routing.snapshotsByTarget.delete(targetId);
    },
  );
}

export async function navigateChromeMcpPage(
  params: ChromeMcpTargetOperation & { url: string },
): Promise<{ url: string }> {
  const resolvedTimeoutMs = resolveBrowserNavigationTimeoutMs(params.timeoutMs);
  const callTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(resolvedTimeoutMs);
  return await withChromeMcpTarget({ ...params, timeoutMs: callTimeoutMs }, async (target) => {
    const page = await navigateChromeMcpPageOnTarget(
      { ...params, timeoutMs: resolvedTimeoutMs },
      target,
      "Chrome MCP tab identity changed while navigation was running; the navigation outcome is unknown.",
    );
    return { url: page.url ?? params.url };
  });
}

export async function navigateChromeMcpPageOnTarget(
  params: ChromeMcpOperationOptions & { targetId: string; url: string; timeoutMs: number },
  target: ChromeMcpPinnedTarget,
  identityChangedMessage: string,
): Promise<ChromeMcpStructuredPage> {
  const options = {
    timeoutMs: resolveChromeMcpNavigateCallTimeoutMs(params.timeoutMs),
    signal: params.signal,
  };
  await target.callTool(
    "navigate_page",
    { pageId: target.pageId, type: "url", url: params.url, timeout: params.timeoutMs },
    options,
  );
  const page = (await target.listTargets(options)).find(
    (entry) => entry.targetId === params.targetId,
  )?.page;
  if (!page) {
    throw new Error(identityChangedMessage);
  }
  return page;
}

export function resolveChromeMcpNavigateCallTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

export async function takeChromeMcpSnapshot(
  params: ChromeMcpTargetOperation,
): Promise<ChromeMcpSnapshotNode> {
  return await withChromeMcpTarget(params, async (target) => {
    getChromeMcpRoutingState(target.session).snapshotsByTarget.delete(params.targetId);
    const result = await target.callTool("take_snapshot", { pageId: target.pageId });
    return registerChromeMcpSnapshot(target.session, params.targetId, result).root;
  });
}

/** Run document-bound evaluations without releasing the target/session lock. */
export async function withChromeMcpDocument<T>(
  params: ChromeMcpTargetOperation,
  task: (document: { evaluate: (fn: string) => Promise<unknown> }) => Promise<T>,
): Promise<T> {
  return await withChromeMcpTarget(params, async (target) => {
    const routing = getChromeMcpRoutingState(target.session);
    try {
      let uid = routing.snapshotsByTarget.get(params.targetId)?.documentUid;
      if (!uid) {
        const snapshot = await target
          .callTool("take_snapshot", { pageId: target.pageId, verbose: true })
          .catch(rethrowChromeMcpDocumentError);
        uid = registerChromeMcpSnapshot(target.session, params.targetId, snapshot).documentUid;
      }
      return await task({
        evaluate: async (fn) => {
          return extractJsonMessage(
            await target
              .callTool("evaluate_script", {
                pageId: target.pageId,
                function: fn,
                args: [uid],
                waitForStableDom: false,
              })
              .catch(rethrowChromeMcpDocumentError),
          );
        },
      });
    } catch (error) {
      if (error instanceof ChromeMcpDocumentUnavailableError) {
        routing.snapshotsByTarget.delete(params.targetId);
      }
      throw error;
    }
  });
}

export type ChromeMcpScreenshotOptions = {
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
};

/** Capture within an existing target operation, including its snapshot ref lifetime. */
export async function takeChromeMcpScreenshotOnTarget(
  params: ChromeMcpTargetOperation & ChromeMcpScreenshotOptions,
  target: ChromeMcpPinnedTarget,
): Promise<Buffer> {
  return await withTempDownloadPath(
    { prefix: "openclaw-chrome-mcp", fileName: "screenshot" },
    async (filePath) => {
      const format = params.format ?? "png";
      await target.callTool(
        "take_screenshot",
        {
          pageId: target.pageId,
          filePath,
          format,
          ...(params.uid
            ? {
                uid: resolveChromeMcpSnapshotRef(target.session, params.targetId, params.uid).uid,
              }
            : {}),
          ...(params.fullPage ? { fullPage: true } : {}),
        },
        params,
      );
      return await fs.readFile(`${filePath}.${format}`);
    },
  );
}

export async function takeChromeMcpScreenshot(
  params: ChromeMcpTargetOperation & ChromeMcpScreenshotOptions,
): Promise<Buffer> {
  return await withChromeMcpTarget(params, (target) =>
    takeChromeMcpScreenshotOnTarget(params, target),
  );
}

export async function clickChromeMcpElement(
  params: ChromeMcpTargetOperation & {
    uid: string;
    doubleClick?: boolean;
  },
): Promise<void> {
  await callTargetTool(params, "click", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
    ...(params.doubleClick ? { dblClick: true } : {}),
  }));
}

export async function clickChromeMcpCoords(
  params: ChromeMcpTargetOperation & {
    x: number;
    y: number;
    doubleClick?: boolean;
  },
): Promise<void> {
  await callTargetTool(params, "click_at", {
    x: params.x,
    y: params.y,
    ...(params.doubleClick ? { dblClick: true } : {}),
  });
}

/** Select an HTML option by value; MCP fill selects by visible label instead. */
export async function selectChromeMcpOption(
  params: ChromeMcpTargetOperation & { uid: string; value: string },
): Promise<void> {
  await evaluateChromeMcpScript({
    ...params,
    args: [params.uid],
    fn: `(el) => {
      if (!(el instanceof HTMLSelectElement)) throw new Error("Element is not a select");
      if (el.matches(":disabled")) throw new Error("Select element is disabled");
      const option = Array.from(el.options).find((entry) => entry.value === ${JSON.stringify(params.value)});
      if (!option) throw new Error("No option has the requested value");
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    }`,
  });
}

export async function fillChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string; value: string },
): Promise<void> {
  await callTargetTool(params, "fill", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
    value: params.value,
  }));
}

export async function fillChromeMcpForm(
  params: ChromeMcpTargetOperation & {
    elements: Array<{ uid: string; value: string }>;
  },
): Promise<void> {
  await callTargetTool(params, "fill_form", (session) => ({
    elements: params.elements.map((element) => ({
      ...element,
      uid: resolveChromeMcpSnapshotRef(session, params.targetId, element.uid).uid,
    })),
  }));
}

export async function hoverChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string },
): Promise<void> {
  await callTargetTool(params, "hover", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
  }));
}

export async function dragChromeMcpElement(
  params: ChromeMcpTargetOperation & { fromUid: string; toUid: string },
): Promise<void> {
  await callTargetTool(params, "drag", (session) => ({
    from_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.fromUid).uid,
    to_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.toUid).uid,
  }));
}

export async function uploadChromeMcpFile(
  params: ChromeMcpTargetOperation & { uid: string; filePaths: string[] },
): Promise<void> {
  await callTargetTool(params, "upload_file", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
    filePaths: params.filePaths,
  }));
}

export async function pressChromeMcpKey(
  params: ChromeMcpTargetOperation & { key: string },
): Promise<void> {
  await callTargetTool(params, "press_key", {
    key: params.key,
  });
}

export async function resizeChromeMcpPage(
  params: ChromeMcpTargetOperation & { width: number; height: number },
): Promise<void> {
  await callTargetTool(params, "resize_page", {
    width: params.width,
    height: params.height,
  });
}

export async function evaluateChromeMcpScript(
  params: ChromeMcpTargetOperation & { fn: string; args?: string[] },
): Promise<unknown> {
  const result = await callTargetTool(params, "evaluate_script", (session) => ({
    function: params.fn,
    ...(params.args?.length
      ? {
          args: params.args.map(
            (ref) => resolveChromeMcpSnapshotRef(session, params.targetId, ref).uid,
          ),
        }
      : {}),
  }));
  return extractJsonMessage(result);
}
