import { prepareGatewayPublicationReaderV1 } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  sessionShareGatewayDeviceIds,
  sessionShareGatewaySourceEnabled,
  sessionShareSelection,
} from "./config.js";
import {
  createSessionShareNodeCommands,
  isUnresolvedRelationError,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
  SESSION_SHARE_CATALOG_LIST_COMMAND,
  SESSION_SHARE_CATALOG_READ_COMMAND,
} from "./node-commands.js";

type Request = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];

export function registerSessionShareGatewayMethods(api: OpenClawPluginApi) {
  for (const [method, command] of [
    ["session-share.list", SESSION_SHARE_LIST_COMMAND],
    ["session-share.read", SESSION_SHARE_READ_COMMAND],
    ["session-share.catalog.list", SESSION_SHARE_CATALOG_LIST_COMMAND],
    ["session-share.catalog.read", SESSION_SHARE_CATALOG_READ_COMMAND],
  ]) {
    api.registerGatewayMethod(
      method!,
      async (request: Request) => {
        try {
          const reader = await prepareGatewayPublicationReaderV1(request);
          const selectionAtStart = JSON.stringify(
            sessionShareSelection(api.runtime.config.current()),
          );
          const assertCurrent = () => {
            request.signal?.throwIfAborted();
            request.client?.connectionSignal?.throwIfAborted();
            request.assertHandlerCurrent?.();
            reader.assertCurrent();
            const config = api.runtime.config.current();
            const selection = sessionShareSelection(config);
            if (
              JSON.stringify(selection) !== selectionAtStart ||
              !sessionShareGatewayDeviceIds(config).includes(reader.deviceId) ||
              !sessionShareGatewaySourceEnabled(config) ||
              !selection?.involvingProfileId
            ) {
              throw new Error("Session Share source access is unavailable");
            }
          };
          assertCurrent();
          if (
            method === "session-share.catalog.list" &&
            isRecord(request.params) &&
            Object.hasOwn(request.params, "includeOriginalPath")
          ) {
            throw new Error("Gateway catalog lists do not support original paths");
          }
          // The reader remains a device. The supplied person narrows publication; it never changes reader authority.
          // Respond inside the source owner's final synchronous disclosure callback.
          const handler = createSessionShareNodeCommands(api, {
            assertCurrent,
            consumeResult: (payload) => {
              assertCurrent();
              request.respond(true, payload);
            },
          }).find((candidate) => candidate.command === command)!;
          await handler.handle(JSON.stringify(request.params));
        } catch (error) {
          if (isUnresolvedRelationError(error)) {
            request.respond(false, undefined, {
              code: "FILTER_UNAVAILABLE",
              message: "Relationship target is unresolved or ambiguous on this source",
            });
            return;
          }
          // Never propagate transcript paths, credentials, or raw source failures to the peer.
          request.respond(false, undefined, {
            code: "INVALID_REQUEST",
            message:
              "Session Share request denied or source unavailable. Refresh the catalog; if this persists, ask the source operator to inspect the session.",
          });
        }
      },
      { scope: "operator.session-share.read", profileAccess: "independent" },
    );
  }
}
