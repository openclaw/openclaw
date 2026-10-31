import type { ComputerActParams } from "openclaw/plugin-sdk/computer-use";
import {
  browserElement,
  browserTarget,
  elementArgs,
  requireWindowTarget,
  windowPointArgs,
  type CuaComputerActParams,
} from "./action-targets.js";
import { CLICK_ACTIONS, normalizeModifiers, parseKeyChord } from "./actions.js";
import type { CuaDriverSession, CuaToolResult } from "./driver-client.js";
import {
  actionEnvelope,
  browserBinding,
  browserDialogEnvelope,
  browserObservation,
  browserToolEnvelope,
  CUA_WIRE_ACTION_NAMES,
  callWindowTool,
  nativeWindows,
  projectApps,
  projectedToolDetails,
  projectProcesses,
  projectWindows,
  windowObservation,
} from "./driver-result.js";
import type { CuaExecutionState } from "./execution-state.js";
import {
  adoptGeneration,
  invalidateBrowserObservation,
  resolveBrowserObservation,
  resolveDialogRef,
  resolveObservation,
  resolveWindowRef,
  verifyGeneration,
  type CuaFrameState,
} from "./frame.js";
import { handleRecordingAct } from "./recording-actions.js";

const CUA_TARGETED_ACTION_NAMES = new Set([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
] as const);

async function handleTargetedAct(
  platform: NodeJS.Platform,
  driver: CuaDriverSession,
  state: CuaFrameState,
  params: CuaComputerActParams,
  signal?: AbortSignal,
): Promise<string> {
  const { ref: windowRef, target } = requireWindowTarget(driver, state, params);
  const base = { pid: target.pid, window_id: target.windowId };
  const delivery = params.deliveryMode ? { delivery_mode: params.deliveryMode } : {};
  const element = elementArgs(state, params, windowRef);
  const optionalTarget = (label: string) =>
    element ??
    (params.x !== undefined || params.y !== undefined
      ? windowPointArgs(state, params, windowRef, params, label)
      : {});
  let tool: string;
  let args: Record<string, unknown>;

  switch (params.action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      tool = "click";
      const { button, count } = CLICK_ACTIONS[params.action];
      const modifiers = normalizeModifiers(params.modifiers, platform);
      args = {
        ...base,
        ...(element ?? windowPointArgs(state, params, windowRef, params, "click")),
        button,
        count,
        ...(modifiers.length ? { modifier: modifiers } : {}),
        ...delivery,
      };
      break;
    }
    case "left_click_drag": {
      if (element) {
        throw new Error("COMPUTER_UNSUPPORTED_ACTION: cua-driver drag has no element target");
      }
      tool = "drag";
      const from = windowPointArgs(
        state,
        params,
        windowRef,
        { x: params.fromX, y: params.fromY },
        "drag start",
      );
      const to = windowPointArgs(state, params, windowRef, params, "drag end");
      args = {
        ...base,
        from_x: from.x,
        from_y: from.y,
        to_x: to.x,
        to_y: to.y,
        ...(from.from_zoom || to.from_zoom ? { from_zoom: true } : {}),
        ...(params.durationMs === undefined
          ? {}
          : { duration_ms: Math.min(10_000, params.durationMs) }),
        ...delivery,
      };
      break;
    }
    case "left_mouse_down":
    case "left_mouse_up": {
      const down = params.action === "left_mouse_down";
      if (platform !== "linux") {
        throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${params.action} is Linux-only`);
      }
      if (element || params.deliveryMode === "foreground") {
        throw new Error(
          `COMPUTER_UNSUPPORTED_ACTION: ${params.action} supports only background window pixels`,
        );
      }
      tool = down ? "mouse_button_down" : "mouse_button_up";
      args = {
        ...base,
        ...(down
          ? { ...windowPointArgs(state, params, windowRef, params, "mouse down"), button: "left" }
          : optionalTarget("mouse up")),
      };
      break;
    }
    case "scroll": {
      if (!params.scrollDirection) {
        throw new Error("COMPUTER_INVALID_REQUEST: scrollDirection is required for scroll");
      }
      if (normalizeModifiers(params.modifiers, platform).length) {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: modifier-held scroll is unsupported by cua-driver",
        );
      }
      tool = "scroll";
      args = {
        ...base,
        ...optionalTarget("scroll"),
        direction: params.scrollDirection,
        by: "line",
        amount: Math.min(50, params.scrollAmount ?? 3),
        ...delivery,
      };
      break;
    }
    case "type": {
      if (!params.text) {
        throw new Error("COMPUTER_INVALID_REQUEST: text is required for type");
      }
      tool = "type_text";
      args = {
        ...base,
        ...optionalTarget("type"),
        text: params.text,
        ...delivery,
      };
      break;
    }
    case "key": {
      const chord = parseKeyChord(params.keys, platform);
      tool = "press_key";
      args = {
        ...base,
        ...optionalTarget("key"),
        ...chord,
        ...delivery,
      };
      break;
    }
    default:
      throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${params.action}`);
  }

  const result = await callWindowTool(driver, state, tool, args, signal);
  return JSON.stringify(actionEnvelope(result));
}

/// Entry point for `computer.act` on the CUA driver. Owns every window- and
/// element-scoped action (targeted input, discovery, app/window lifecycle) and
/// hands screen-scoped desktop actions to the injected `handleDesktop`.
export async function handleWindowAct(
  platform: NodeJS.Platform,
  driver: CuaDriverSession,
  state: CuaFrameState,
  execution: CuaExecutionState,
  params: ComputerActParams,
  handleDesktop: (
    platform: NodeJS.Platform,
    driver: CuaDriverSession,
    state: CuaFrameState,
    params: ComputerActParams,
    signal?: AbortSignal,
  ) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  const input = params as CuaComputerActParams & Record<string, unknown>;
  if (
    CUA_TARGETED_ACTION_NAMES.has(input.action as never) &&
    (input.windowRef || input.elementRef)
  ) {
    return await handleTargetedAct(platform, driver, state, input, signal);
  }
  if ((CUA_WIRE_ACTION_NAMES as readonly string[]).includes(input.action)) {
    return await handleDesktop(platform, driver, state, params, signal);
  }
  const recordingResult = await handleRecordingAct(
    driver,
    execution.recording,
    execution.resources,
    input,
    signal,
  );
  if (recordingResult !== undefined) {
    return recordingResult;
  }
  const resources = execution.resources;

  switch (input.action) {
    case "get_browser_state": {
      verifyGeneration(state, driver.generation);
      if (input.windowRef) {
        const window = resolveWindowRef(state, input.windowRef);
        const result = await callWindowTool(
          driver,
          state,
          "get_browser_state",
          { pid: window.pid, window_id: window.windowId },
          signal,
        );
        return JSON.stringify(browserBinding(result, state, input.windowRef));
      }
      const target = browserTarget(driver, state, input);
      const snapshotFormat = input.snapshotFormat ?? "dom_refs_v1";
      if (
        snapshotFormat === "dom_refs_v1" &&
        (input.elementRef || input.query || input.continuation)
      ) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: elementRef, query, and continuation require snapshotFormat=semantic_v2",
        );
      }
      const scopeRef = browserElement(state, input, target);
      const result = await callWindowTool(
        driver,
        state,
        "get_browser_state",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          snapshot_format: snapshotFormat,
          include_screenshot: input.includeScreenshot ?? true,
          ...(scopeRef ? { scope_ref: scopeRef } : {}),
          ...(input.query ? { query: input.query } : {}),
          ...(input.continuation ? { continuation: input.continuation } : {}),
        },
        signal,
      );
      return JSON.stringify(browserObservation(result, state, target));
    }
    case "browser_prepare": {
      const { target } = requireWindowTarget(driver, state, input);
      const profile = input.profile ?? "isolated_new";
      if (profile === "isolated_named" && !input.profileName) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: profileName is required for an isolated_named browser profile",
        );
      }
      if (profile === "isolated_new" && input.profileName) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: profileName is valid only for an isolated_named browser profile",
        );
      }
      const result = await callWindowTool(
        driver,
        state,
        "browser_prepare",
        {
          pid: target.pid,
          allow_launch: true,
          profile: {
            mode: profile,
            ...(input.profileName ? { name: input.profileName } : {}),
          },
        },
        signal,
      );
      return JSON.stringify(browserToolEnvelope(result, "browser_prepare"));
    }
    case "browser_navigate":
    case "browser_click":
    case "browser_type":
    case "browser_pointer": {
      const target = browserTarget(driver, state, input);
      const args: Record<string, unknown> = {
        target_id: target.targetId,
        tab_id: target.tabId,
      };
      if (input.action === "browser_navigate") {
        args.url = input.url;
      } else if (input.action === "browser_type") {
        Object.assign(args, {
          ref: browserElement(state, input, target)!,
          text: input.text,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.replace !== undefined ? { replace: input.replace } : {}),
        });
      } else {
        resolveBrowserObservation(state, input.observationId!, target.browserRef, target.pageRef);
        const ref = browserElement(state, input, target);
        if (input.action === "browser_pointer") {
          const destinationRef = browserElement(state, input, target, input.destinationElementRef);
          Object.assign(args, {
            action: input.pointerAction,
            ...(destinationRef ? { destination_ref: destinationRef } : {}),
            ...(input.toX !== undefined ? { to_x: input.toX } : {}),
            ...(input.toY !== undefined ? { to_y: input.toY } : {}),
            ...(input.deltaX !== undefined ? { delta_x: input.deltaX } : {}),
            ...(input.deltaY !== undefined ? { delta_y: input.deltaY } : {}),
          });
        }
        Object.assign(args, {
          ...(ref ? { ref } : {}),
          ...(input.x !== undefined ? { x: input.x } : {}),
          ...(input.y !== undefined ? { y: input.y } : {}),
          ...(input.inputRoute ? { input_route: input.inputRoute } : {}),
        });
      }
      const result = await callWindowTool(driver, state, input.action, args, signal);
      if (input.action === "browser_navigate") {
        invalidateBrowserObservation(state);
      }
      return JSON.stringify(browserToolEnvelope(result, input.action));
    }
    case "browser_dialog": {
      const target = browserTarget(driver, state, input);
      const dialogId =
        input.dialogAction === "inspect"
          ? undefined
          : resolveDialogRef(state, input.dialogRef!, target.browserRef, target.pageRef);
      const result = await callWindowTool(
        driver,
        state,
        "browser_dialog",
        {
          target_id: target.targetId,
          tab_id: target.tabId,
          action: input.dialogAction,
          ...(dialogId ? { dialog_id: dialogId } : {}),
          ...(input.promptText !== undefined ? { prompt_text: input.promptText } : {}),
          ...(input.deliveryMode ? { delivery_mode: input.deliveryMode } : {}),
        },
        signal,
      );
      if (input.dialogAction !== "inspect") {
        state.dialog = undefined;
      }
      return JSON.stringify(browserDialogEnvelope(result, state, target));
    }
    case "browser_set_input_files":
    case "browser_download": {
      const target = browserTarget(driver, state, input);
      const ref = browserElement(state, input, target)!;
      const resource =
        input.action === "browser_download"
          ? await resources.createDirectory("browser-download")
          : undefined;
      const resourceArgs = resource
        ? { destination_root: resource.path }
        : { files: await resources.resolveFiles(input.resourceHandles ?? []) };
      let result: CuaToolResult;
      try {
        result = await callWindowTool(
          driver,
          state,
          input.action,
          {
            target_id: target.targetId,
            tab_id: target.tabId,
            ref,
            ...resourceArgs,
          },
          signal,
        );
      } catch (error) {
        if (resource) {
          await resources.discard(resource.handle).catch(() => {});
        }
        signal?.throwIfAborted();
        throw new Error(
          `COMPUTER_DRIVER_ERROR: ${input.action} failed; inspect node logs and resource state before retrying`,
          { cause: error },
        );
      }
      const envelope = browserToolEnvelope(result, input.action);
      if (!resource) {
        return JSON.stringify(envelope);
      }
      const fileResourceHandles = await resources.captureFiles(resource.handle);
      return JSON.stringify({
        ...envelope,
        details: {
          ...envelope.details,
          resourceHandle: resource.handle,
          fileResourceHandles,
        },
      });
    }
    case "list_apps": {
      const result = await callWindowTool(driver, state, "list_apps", {}, signal);
      state.apps = new Map();
      const structured = projectedToolDetails(result, "list_apps");
      return JSON.stringify({ ok: true, details: projectApps(state, structured.apps) });
    }
    case "list_windows": {
      const result = await callWindowTool(driver, state, "list_windows", {}, signal);
      const structured = projectedToolDetails(result, "list_windows");
      return JSON.stringify({
        ok: true,
        details: projectWindows(state, nativeWindows(structured.windows)),
      });
    }
    case "get_accessibility_tree": {
      if (input.windowRef || input.query || input.depth !== undefined || input.maxElements) {
        throw new Error(
          "COMPUTER_UNSUPPORTED_ACTION: CUA Driver exposes get_accessibility_tree only as unfiltered desktop discovery; use get_window_state for a window tree",
        );
      }
      const result = await callWindowTool(driver, state, "get_accessibility_tree", {}, signal);
      const structured = projectedToolDetails(result, "get_accessibility_tree");
      return JSON.stringify({
        ok: true,
        details: {
          ...projectWindows(state, nativeWindows(structured.windows)),
          ...projectProcesses(structured.processes),
        },
      });
    }
    case "get_cursor_position": {
      const result = await driver.getCursorPosition(signal);
      return JSON.stringify({
        ok: true,
        details: projectedToolDetails(result, "get_cursor_position"),
      });
    }
    case "get_window_state": {
      verifyGeneration(state, driver.generation);
      const window = resolveWindowRef(state, input.windowRef!);
      const result = await callWindowTool(
        driver,
        state,
        "get_window_state",
        {
          pid: window.pid,
          window_id: window.windowId,
          include_screenshot: input.includeScreenshot ?? true,
          max_elements: input.maxElements ?? 2_000,
          ...(input.depth !== undefined ? { max_depth: Math.max(1, input.depth) } : {}),
          ...(input.query ? { query: input.query } : {}),
        },
        signal,
      );
      return JSON.stringify(windowObservation(result, state, input.windowRef!));
    }
    case "launch_app": {
      verifyGeneration(state, driver.generation);
      const appName = input.app!;
      const app = state.apps?.get(appName);
      if (!app) {
        throw new Error("COMPUTER_STALE_OBSERVATION: refresh list_apps and retry");
      }
      const result = await callWindowTool(
        driver,
        state,
        "launch_app",
        platform !== "darwin" && app.launchPath
          ? { launch_path: app.launchPath }
          : app.bundleId
            ? { bundle_id: app.bundleId }
            : { name: app.name },
        signal,
      );
      const structured = projectedToolDetails(result, "launch_app");
      return JSON.stringify({
        ...actionEnvelope(result),
        details: {
          app: projectApps(state, [structured]).apps,
          ...projectWindows(state, nativeWindows(structured.windows)),
        },
      });
    }
    case "kill_app": {
      verifyGeneration(state, driver.generation);
      const appName = input.app!;
      const app = state.apps?.get(appName);
      if (!app?.pid) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: kill_app requires a running app reference from list_apps",
        );
      }
      const result = await callWindowTool(driver, state, "kill_app", { pid: app.pid }, signal);
      return JSON.stringify(actionEnvelope(result, { app: appName }));
    }
    case "bring_to_front":
    case "set_value":
    case "invoke_menu":
    case "zoom": {
      const { ref, target } = requireWindowTarget(driver, state, input);
      const args: Record<string, unknown> = { pid: target.pid, window_id: target.windowId };
      if (
        (input.action === "set_value" || input.action === "invoke_menu") &&
        input.deliveryMode === "foreground"
      ) {
        throw new Error(
          `COMPUTER_UNSUPPORTED_ACTION: cua-driver ${input.action} is background accessibility delivery`,
        );
      }
      if (input.action === "set_value") {
        const element = elementArgs(state, input, ref);
        if (!element) {
          throw new Error("COMPUTER_INVALID_REQUEST: elementRef is required for set_value");
        }
        Object.assign(args, element, { value: input.value });
      } else if (input.action === "invoke_menu") {
        args.path = input.path;
      } else if (input.action === "zoom") {
        resolveObservation(state, input.observationId!, ref);
        Object.assign(args, { x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2 });
      }
      const result = await callWindowTool(driver, state, input.action, args, signal);
      return JSON.stringify(
        input.action === "zoom"
          ? windowObservation(result, state, ref, { fromZoom: true })
          : actionEnvelope(result),
      );
    }
    case "escalate_scope": {
      const result = await driver.getSessionState(signal);
      adoptGeneration(state, driver.generation);
      return JSON.stringify({
        ok: true,
        details: {
          captureScope: result.captureScope,
          effectiveScope: result.effectiveScope,
          desktopUnlocked: result.desktopUnlocked,
        },
      });
    }
    default:
      throw new Error(`COMPUTER_UNSUPPORTED_ACTION: ${input.action}`);
  }
}
