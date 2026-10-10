import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { evaluateChromeMcpScript, uploadChromeMcpFile } from "../chrome-mcp.js";
import { resolveExistingUploadPaths } from "../paths.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { createTabRouteRegistrar } from "./agent.prepared.js";
import { requirePwAi } from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readRouteTimerTimeoutMs } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toStringArray, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentActHookRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  const register = createTabRouteRegistrar(app, ctx);
  register("/hooks/file-chooser", (body, res) => {
    const ref = toStringOrEmpty(body.ref) || undefined;
    const inputRef = toStringOrEmpty(body.inputRef) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const paths = toStringArray(body.paths) ?? [];
    const timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs);
    if (!paths.length) {
      return jsonError(res, 400, "paths are required");
    }

    return async ({ profileCtx, cdpUrl, tab, signal, assertCurrent }) => {
      const resolvedResult = await resolveExistingUploadPaths({ requestedPaths: paths });
      if (!resolvedResult.ok) {
        res.status(400).json({ error: resolvedResult.error });
        return;
      }
      const resolvedPaths = resolvedResult.paths;
      const capabilities = getBrowserProfileCapabilities(profileCtx.profile);

      if (capabilities.usesChromeMcp) {
        if (element) {
          return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadElement);
        }
        const uid = inputRef || ref;
        if (!uid) {
          return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.uploadRefRequired);
        }
        if (assertCurrent) {
          await assertCurrent();
        }
        await uploadChromeMcpFile({
          profileName: profileCtx.profile.name,
          profile: profileCtx.profile,
          targetId: tab.targetId,
          uid,
          filePaths: resolvedPaths,
          timeoutMs: timeoutMs ?? ctx.state().resolved.actionTimeoutMs,
          signal,
        });
        return res.json({ ok: true });
      }

      const pw = await requirePwAi(res, "file chooser hook");
      if (!pw) {
        return;
      }

      if ((inputRef || element) && ref) {
        return jsonError(res, 400, "ref cannot be combined with inputRef/element");
      }
      const target = {
        cdpUrl,
        browserFilesystemLocal: capabilities.browserFilesystemLocal,
        // Extension uploads take the byte-payload branch (Store installs cannot read
        // gateway-local paths), but extension browsers run on this machine, so uploads
        // that reach the payload size cap keep the local path handoff that file-access
        // extensions still accept instead of losing large uploads that worked before.
        uploadPathsFallbackOnPayloadLimit: profileCtx.profile.driver === "extension",
        targetId: tab.targetId,
        paths: resolvedPaths,
        timeoutMs,
        ssrfPolicy: ctx.state().resolved.ssrfPolicy,
        ...(assertCurrent ? { assertCurrent } : {}),
      };
      if (inputRef || element) {
        await pw.setInputFilesViaPlaywright({ ...target, inputRef, element, signal });
      } else if (ref) {
        await pw.uploadViaPlaywright({ ...target, ref, signal });
      } else {
        await pw.armFileUploadViaPlaywright(target);
      }
      res.json({ ok: true });
    };
  });

  register("/hooks/dialog", (body, res) => {
    const accept = toBoolean(body.accept);
    const promptText = readStringValue(body.promptText);
    const timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs);
    const dialogId = toStringOrEmpty(body.dialogId) || undefined;
    if (accept === undefined) {
      return jsonError(res, 400, "accept is required");
    }

    return async ({ profileCtx, cdpUrl, tab, signal, assertCurrent }) => {
      if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
        if (dialogId) {
          return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.dialogId);
        }
        if (timeoutMs) {
          return jsonError(res, 501, EXISTING_SESSION_LIMITS.hooks.dialogTimeout);
        }
        if (assertCurrent) {
          await assertCurrent();
        }
        await evaluateChromeMcpScript({
          profileName: profileCtx.profile.name,
          profile: profileCtx.profile,
          targetId: tab.targetId,
          timeoutMs: ctx.state().resolved.actionTimeoutMs,
          signal,
          // Existing-session Chrome MCP has no dialog hook primitive. Patch
          // one-shot window dialog functions in-page, then restore them.
          fn: `() => {
              const state = (window.__openclawDialogHook ??= {});
              if (!state.originals) {
                state.originals = {
                  alert: window.alert.bind(window),
                  confirm: window.confirm.bind(window),
                  prompt: window.prompt.bind(window),
                };
              }
              const originals = state.originals;
              const restore = () => {
                window.alert = originals.alert;
                window.confirm = originals.confirm;
                window.prompt = originals.prompt;
                delete window.__openclawDialogHook;
              };
              window.alert = () => {
                restore();
                return undefined;
              };
              window.confirm = () => {
                restore();
                return ${accept ? "true" : "false"};
              };
              window.prompt = () => {
                restore();
                return ${accept ? JSON.stringify(promptText ?? "") : "null"};
              };
              return true;
            }`,
        });
        return res.json({ ok: true });
      }
      const pw = await requirePwAi(res, "dialog hook");
      if (!pw) {
        return;
      }
      await pw.armDialogViaPlaywright({
        cdpUrl,
        targetId: tab.targetId,
        dialogId,
        accept,
        promptText,
        timeoutMs: timeoutMs ?? undefined,
        ...(assertCurrent ? { assertCurrent } : {}),
      });
      res.json({ ok: true });
    };
  });
}
