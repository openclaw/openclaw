import { jsonResult, textResult } from "openclaw/plugin-sdk/provider-tools";
import type { ComputerToolParams } from "./computer-tool.schema.js";
import { extractResult, getCuaDriverClient } from "./cua-driver-client.js";

export async function executeComputerTool(
  params: ComputerToolParams,
  cuaDriverPath: string,
): Promise<ReturnType<typeof jsonResult>> {
  const client = getCuaDriverClient(cuaDriverPath);
  const { action } = params;

  switch (action) {
    case "screenshot": {
      if (!params.window_id) {
        // Convenience: find the window via list_windows filtered by app_name.
        const listResult = extractResult(
          await client.callTool("list_windows", { on_screen_only: true }),
        );
        if (listResult.isError) return jsonResult({ ok: false, error: listResult.text });
        // Return the window list text so the agent can pick the right window_id.
        return jsonResult({ ok: true, windows: listResult.text });
      }
      const result = extractResult(
        await client.callTool("screenshot", {
          window_id: params.window_id,
          format: "jpeg",
          quality: 85,
        }),
      );
      return buildResult(result);
    }

    case "get_app_state": {
      if (!params.app_name && (!params.pid || !params.window_id)) {
        return jsonResult({
          ok: false,
          error: "get_app_state requires app_name or pid+window_id.",
        });
      }
      if (params.app_name && (!params.pid || !params.window_id)) {
        // Resolve pid+window_id from app_name via list_windows.
        const resolved = await resolveWindow(client, params.app_name);
        if (!resolved) {
          return jsonResult({
            ok: false,
            error: `No on-screen window found for "${params.app_name}". Is the app running?`,
          });
        }
        const result = extractResult(
          await client.callTool("get_window_state", {
            pid: resolved.pid,
            window_id: resolved.windowId,
            ...(params.query ? { query: params.query } : {}),
            ...(params.javascript ? { javascript: params.javascript } : {}),
          }),
        );
        return buildResult(result);
      }
      const result = extractResult(
        await client.callTool("get_window_state", {
          pid: params.pid,
          window_id: params.window_id,
          ...(params.query ? { query: params.query } : {}),
          ...(params.javascript ? { javascript: params.javascript } : {}),
        }),
      );
      return buildResult(result);
    }

    case "list_windows": {
      const result = extractResult(await client.callTool("list_windows", { on_screen_only: true }));
      return buildResult(result);
    }

    case "list_apps": {
      const result = extractResult(await client.callTool("list_apps", {}));
      return buildResult(result);
    }

    case "launch_app": {
      if (!params.bundle_id && !params.app_name) {
        return jsonResult({ ok: false, error: "launch_app requires bundle_id or app_name." });
      }
      const result = extractResult(
        await client.callTool("launch_app", {
          ...(params.bundle_id ? { bundle_id: params.bundle_id } : { name: params.app_name }),
        }),
      );
      return buildResult(result);
    }

    case "click":
    case "double_click":
    case "right_click": {
      if (!params.pid) return jsonResult({ ok: false, error: `${action} requires pid.` });
      const toolName =
        action === "double_click"
          ? "double_click"
          : action === "right_click"
            ? "right_click"
            : "click";
      const args: Record<string, unknown> = { pid: params.pid };
      if (params.element_index !== undefined && params.window_id !== undefined) {
        args.element_index = params.element_index;
        args.window_id = params.window_id;
      } else if (params.x !== undefined && params.y !== undefined) {
        args.x = params.x;
        args.y = params.y;
      } else {
        return jsonResult({
          ok: false,
          error: `${action} requires element_index+window_id or x+y.`,
        });
      }
      if (params.modifier?.length) args.modifier = params.modifier;
      const result = extractResult(await client.callTool(toolName, args));
      return buildResult(result);
    }

    case "scroll": {
      if (!params.pid) return jsonResult({ ok: false, error: "scroll requires pid." });
      const args: Record<string, unknown> = {
        pid: params.pid,
        direction: params.direction ?? "down",
        amount: params.amount ?? 3,
      };
      if (params.element_index !== undefined && params.window_id !== undefined) {
        args.element_index = params.element_index;
        args.window_id = params.window_id;
      } else if (params.x !== undefined && params.y !== undefined) {
        args.x = params.x;
        args.y = params.y;
      }
      const result = extractResult(await client.callTool("scroll", args));
      return buildResult(result);
    }

    case "type": {
      if (!params.pid) return jsonResult({ ok: false, error: "type requires pid." });
      if (!params.text) return jsonResult({ ok: false, error: "type requires text." });
      const result = extractResult(
        await client.callTool("type_text", { pid: params.pid, text: params.text }),
      );
      return buildResult(result);
    }

    case "type_chars": {
      if (!params.pid) return jsonResult({ ok: false, error: "type_chars requires pid." });
      if (!params.text) return jsonResult({ ok: false, error: "type_chars requires text." });
      const result = extractResult(
        await client.callTool("type_text_chars", { pid: params.pid, text: params.text }),
      );
      return buildResult(result);
    }

    case "key": {
      if (!params.pid) return jsonResult({ ok: false, error: "key requires pid." });
      if (!params.key) return jsonResult({ ok: false, error: "key requires key." });
      const result = extractResult(
        await client.callTool("press_key", { pid: params.pid, key: params.key }),
      );
      return buildResult(result);
    }

    case "hotkey": {
      if (!params.pid) return jsonResult({ ok: false, error: "hotkey requires pid." });
      if (!params.keys?.length) return jsonResult({ ok: false, error: "hotkey requires keys." });
      const result = extractResult(
        await client.callTool("hotkey", { pid: params.pid, keys: params.keys }),
      );
      return buildResult(result);
    }

    case "set_value": {
      if (!params.pid || !params.window_id || params.element_index === undefined) {
        return jsonResult({
          ok: false,
          error: "set_value requires pid, window_id, element_index.",
        });
      }
      if (!params.value) return jsonResult({ ok: false, error: "set_value requires value." });
      const result = extractResult(
        await client.callTool("set_value", {
          pid: params.pid,
          window_id: params.window_id,
          element_index: params.element_index,
          value: params.value,
        }),
      );
      return buildResult(result);
    }

    case "execute_javascript":
    case "get_text":
    case "query_dom":
    case "enable_javascript_apple_events": {
      if (!params.pid || !params.window_id) {
        return jsonResult({
          ok: false,
          error: `page action=${action} requires pid and window_id.`,
        });
      }
      const args: Record<string, unknown> = {
        pid: params.pid,
        window_id: params.window_id,
        action,
      };
      if (params.javascript) args.javascript = params.javascript;
      if (params.css_selector) args.css_selector = params.css_selector;
      if (params.attributes) args.attributes = params.attributes;
      if (params.bundle_id) args.bundle_id = params.bundle_id;
      if (params.user_has_confirmed_enabling !== undefined) {
        args.user_has_confirmed_enabling = params.user_has_confirmed_enabling;
      }
      const result = extractResult(await client.callTool("page", args));
      return buildResult(result);
    }

    default:
      return jsonResult({ ok: false, error: `Unknown action: ${action}` });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(extracted: ReturnType<typeof extractResult>) {
  if (extracted.images.length > 0) {
    // Return first image as base64 alongside the text summary.
    const img = extracted.images[0]!;
    return {
      content: [
        { type: "text" as const, text: extracted.text },
        { type: "image" as const, data: img.data, mimeType: img.mimeType },
      ],
      details: { text: extracted.text, isError: extracted.isError },
    };
  }
  return textResult(extracted.text, { isError: extracted.isError });
}

async function resolveWindow(
  client: ReturnType<typeof getCuaDriverClient>,
  appName: string,
): Promise<{ pid: number; windowId: number } | null> {
  const result = extractResult(await client.callTool("list_windows", { on_screen_only: true }));
  if (result.isError) return null;
  // Parse the structured content — cua-driver returns structuredContent on list_windows.
  // Fall back to text parsing if structured content isn't available.
  const needle = appName.toLowerCase();
  const match = result.text
    .split("\n")
    .find((line) => line.toLowerCase().includes(needle) && line.includes("[window_id:"));
  if (!match) return null;
  const pidMatch = /\(pid\s+(\d+)\)/.exec(match);
  const wIdMatch = /\[window_id:\s*(\d+)\]/.exec(match);
  if (!pidMatch || !wIdMatch) return null;
  return { pid: parseInt(pidMatch[1]!, 10), windowId: parseInt(wIdMatch[1]!, 10) };
}
