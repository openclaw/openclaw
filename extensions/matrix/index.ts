import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { runWithLocalStateMutationOwner } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import { setMatrixRuntimeLifecycle } from "./runtime-setter-api.js";
import { registerMatrixSubagentHooks } from "./subagent-hooks-api.js";

const loadMatrixHandlersRuntimeModule = createLazyRuntimeModule(
  () => import("./plugin-entry.handlers.runtime.js"),
);

export function registerMatrixFullRuntime(api: OpenClawPluginApi): void {
  setMatrixRuntimeLifecycle(api.runtime, api.lifecycle);
  const methods = {
    "matrix.verify.recoveryKey": "handleVerifyRecoveryKey",
    "matrix.verify.bootstrap": "handleVerificationBootstrap",
    "matrix.verify.status": "handleVerificationStatus",
  } as const;
  for (const [method, handler] of Object.entries(methods)) {
    for (const ownerBound of [false, true]) {
      api.registerGatewayMethod(ownerBound ? `${method}.owner` : method, async (ctx) => {
        let response: Parameters<typeof ctx.respond> | undefined;
        let assertOwnerCurrent: (() => void) | undefined;
        let accepted = false;
        const run = async (assertCurrent?: () => void) => {
          const runtime = await loadMatrixHandlersRuntimeModule();
          assertCurrent?.();
          assertOwnerCurrent = assertCurrent;
          accepted = true;
          await runtime[handler](
            assertCurrent
              ? {
                  ...ctx,
                  respond: (...args) => {
                    response = args;
                  },
                }
              : ctx,
          );
        };
        if (!ownerBound && ctx.params.expectedOwnerId === undefined) {
          await run();
          return;
        }
        try {
          if (
            typeof ctx.params.expectedOwnerId !== "string" ||
            !ctx.params.expectedOwnerId.trim()
          ) {
            throw new Error("expectedOwnerId must be a non-empty string");
          }
          await runWithLocalStateMutationOwner(ctx.params.expectedOwnerId, ctx, run);
          assertOwnerCurrent?.();
          if (response) {
            ctx.respond(...response);
          }
        } catch (error) {
          ctx.respond(false, undefined, {
            code: "UNAVAILABLE",
            message: String(error),
            ...(!accepted ? { details: { mutationAccepted: false } } : {}),
          });
        }
      });
    }
  }

  registerMatrixSubagentHooks(api);
}

export default defineBundledChannelEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "matrixPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setMatrixRuntime",
  },
  registerCliMetadata: registerMatrixCliMetadata,
  registerFull: registerMatrixFullRuntime,
});
