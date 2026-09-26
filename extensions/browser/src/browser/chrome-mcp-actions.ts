// Executes Chrome MCP navigation, snapshot, screenshot, and page actions.
import fs from "node:fs/promises";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { withTempDownloadPath } from "openclaw/plugin-sdk/temp-path";
import { resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import {
  rethrowChromeMcpDocumentError,
  ChromeMcpDocumentUnavailableError,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
  type ChromeMcpTargetOperation,
} from "./chrome-mcp-contracts.js";
import { extractJsonMessage, extractSnapshot } from "./chrome-mcp-result.js";
import {
  callTargetTool,
  callTool,
  getChromeMcpRoutingState,
  listChromeMcpTargetsWithLease,
  resolveChromeMcpSnapshotRef,
  registerChromeMcpSnapshot,
  withChromeMcpTarget,
  type ChromeMcpPinnedTarget,
} from "./chrome-mcp-routing.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";

/** Ensure a Chrome MCP session can be started for the profile. */
export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  await callTargetTool(
    {
      profileName,
      profile: typeof profileOptions === "string" ? undefined : profileOptions,
      userDataDir: typeof profileOptions === "string" ? profileOptions : undefined,
      targetId,
      ...options,
    },
    "select_page",
    { bringToFront: true },
  );
}

/** Close a Chrome MCP page by target id. */
export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  const profile = typeof profileOptions === "string" ? undefined : profileOptions;
  const userDataDir = typeof profileOptions === "string" ? profileOptions : undefined;
  await withChromeMcpTarget(
    {
      profileName,
      profile,
      userDataDir,
      targetId,
      ...options,
    },
    async (target) => {
      await callTool(
        profileName,
        target.profileOptions,
        "close_page",
        { pageId: target.pageId },
        options,
        target.lease,
      );
      // Retire inside the same operation lock so queued work cannot dispatch
      // against a closed page id. A later list gets a new opaque handle even if
      // Chrome reuses that numeric id.
      const routing = getChromeMcpRoutingState(target.lease.session);
      routing.targetIdByPageId.delete(target.pageId);
      routing.snapshotsByTarget.delete(targetId);
    },
  );
}

/** Navigate a Chrome MCP page and return its resolved URL. */
export async function navigateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const resolvedTimeoutMs = resolveBrowserNavigationTimeoutMs(params.timeoutMs);
  const callTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(resolvedTimeoutMs);
  return await withChromeMcpTarget({ ...params, timeoutMs: callTimeoutMs }, async (target) => {
    await callTool(
      params.profileName,
      target.profileOptions,
      "navigate_page",
      {
        pageId: target.pageId,
        type: "url",
        url: params.url,
        timeout: resolvedTimeoutMs,
      },
      { timeoutMs: callTimeoutMs, signal: params.signal },
      target.lease,
    );
    const pages = await listChromeMcpTargetsWithLease({
      profileName: params.profileName,
      profileOptions: target.profileOptions,
      lease: target.lease,
      options: { timeoutMs: callTimeoutMs, signal: params.signal },
    });
    const page = pages.find((entry) => entry.targetId === params.targetId)?.page;
    if (!page) {
      throw new Error(
        "Chrome MCP tab identity changed while navigation was running; the navigation outcome is unknown.",
      );
    }
    return { url: page.url ?? params.url };
  });
}

/** Add call-level grace around the MCP navigate timeout. */
export function resolveChromeMcpNavigateCallTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

/** Take a structured Chrome MCP snapshot for one page. */
export async function takeChromeMcpSnapshot(
  params: ChromeMcpTargetOperation,
): Promise<ChromeMcpSnapshotNode> {
  return await withChromeMcpTarget(params, async (target) => {
    getChromeMcpRoutingState(target.lease.session).snapshotsByTarget.delete(params.targetId);
    const result = await callTool(
      params.profileName,
      target.profileOptions,
      "take_snapshot",
      { pageId: target.pageId },
      params,
      target.lease,
    );
    return registerChromeMcpSnapshot(target.lease.session, params.targetId, extractSnapshot(result))
      .root;
  });
}

/** Run document-bound evaluations without releasing the target/session lock. */
export async function withChromeMcpDocument<T>(
  params: ChromeMcpTargetOperation,
  task: (document: { evaluate: (fn: string) => Promise<unknown> }) => Promise<T>,
): Promise<T> {
  return await withChromeMcpTarget(params, async (target) => {
    const routing = getChromeMcpRoutingState(target.lease.session);
    try {
      let uid = routing.snapshotsByTarget.get(params.targetId)?.documentUid;
      if (!uid) {
        const snapshot = extractSnapshot(
          await callTool(
            params.profileName,
            target.profileOptions,
            "take_snapshot",
            { pageId: target.pageId, verbose: true },
            params,
            target.lease,
          ).catch(rethrowChromeMcpDocumentError),
        );
        uid = registerChromeMcpSnapshot(
          target.lease.session,
          params.targetId,
          snapshot,
        ).documentUid;
      }
      return await task({
        evaluate: async (fn) => {
          return extractJsonMessage(
            await callTool(
              params.profileName,
              target.profileOptions,
              "evaluate_script",
              { pageId: target.pageId, function: fn, args: [uid], waitForStableDom: false },
              params,
              target.lease,
            ).catch(rethrowChromeMcpDocumentError),
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
      await callTool(
        params.profileName,
        target.profileOptions,
        "take_screenshot",
        {
          pageId: target.pageId,
          filePath,
          format,
          ...(params.uid
            ? {
                uid: resolveChromeMcpSnapshotRef(target.lease.session, params.targetId, params.uid)
                  .uid,
              }
            : {}),
          ...(params.fullPage ? { fullPage: true } : {}),
        },
        params,
        target.lease,
      );
      return await fs.readFile(`${filePath}.${format}`);
    },
  );
}

/** Take a screenshot via Chrome MCP and return the image bytes. */
export async function takeChromeMcpScreenshot(
  params: ChromeMcpTargetOperation & ChromeMcpScreenshotOptions,
): Promise<Buffer> {
  return await withChromeMcpTarget(params, (target) =>
    takeChromeMcpScreenshotOnTarget(params, target),
  );
}

/** Click a Chrome MCP snapshot element by uid. */
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

/** Click viewport coordinates through Chrome MCP's native pointer input. */
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

/** Fill one Chrome MCP element by uid. */
export async function fillChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string; value: string },
): Promise<void> {
  await callTargetTool(params, "fill", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
    value: params.value,
  }));
}

/** Fill multiple Chrome MCP form elements in one tool call. */
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

/** Hover a Chrome MCP snapshot element by uid. */
export async function hoverChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string },
): Promise<void> {
  await callTargetTool(params, "hover", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
  }));
}

/** Drag between two Chrome MCP snapshot element uids. */
export async function dragChromeMcpElement(
  params: ChromeMcpTargetOperation & { fromUid: string; toUid: string },
): Promise<void> {
  await callTargetTool(params, "drag", (session) => ({
    from_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.fromUid).uid,
    to_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.toUid).uid,
  }));
}

/** Upload local files into a Chrome MCP file input by uid. */
export async function uploadChromeMcpFile(
  params: ChromeMcpTargetOperation & { uid: string; filePaths: string[] },
): Promise<void> {
  await callTargetTool(params, "upload_file", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid).uid,
    filePaths: params.filePaths,
  }));
}

/** Press a keyboard key in a Chrome MCP page. */
export async function pressChromeMcpKey(
  params: ChromeMcpTargetOperation & { key: string },
): Promise<void> {
  await callTargetTool(params, "press_key", {
    key: params.key,
  });
}

/** Resize a Chrome MCP page viewport. */
export async function resizeChromeMcpPage(
  params: ChromeMcpTargetOperation & { width: number; height: number },
): Promise<void> {
  await callTargetTool(params, "resize_page", {
    width: params.width,
    height: params.height,
  });
}

/** Evaluate a JavaScript function in a Chrome MCP page. */
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
