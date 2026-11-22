import { prepareGatewayPublicationReaderV1 } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  sessionShareGatewayDeviceIds,
  sessionShareGatewaySourceEnabled,
  sessionShareSelection,
} from "./config.js";
import {
  createSessionShareNodeCommands,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
} from "./node-commands.js";

type Request = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];

export function registerSessionShareGatewayMethods(api: OpenClawPluginApi) {
  for (const [method, command] of [
    ["session-share.list", SESSION_SHARE_LIST_COMMAND],
    ["session-share.read", SESSION_SHARE_READ_COMMAND],
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
          // The reader remains a device. Only source-owned config selects the person.
          // Respond inside the source owner's final synchronous disclosure callback.
          const handler = createSessionShareNodeCommands(api, {
            assertCurrent,
            consumeResult: (payload) => {
              assertCurrent();
              request.respond(true, payload);
            },
          }).find((candidate) => candidate.command === command)!;
          await handler.handle(JSON.stringify(request.params));
        } catch {
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
