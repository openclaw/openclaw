import { getGatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { OpenClawPluginApi, OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MIRROR_CONFIG_PATH, MIRROR_TOKEN_PATH, parseBeamMirrorConfig } from "./mirror-config.js";
import type { BeamMirrorEnrollment, MirrorPublicationStoreValue } from "./mirror-publication.js";
import { createBeamMirrorRunner } from "./mirror.js";

function createBeamMirrorService(params: {
  runtime: PluginRuntime;
  resolveExecutable: () => Promise<string>;
  onRunner?: (runner: ReturnType<typeof createBeamMirrorRunner> | undefined) => void;
}): OpenClawPluginServiceV2 {
  return {
    id: "beam-mirror",
    apiVersion: 2,
    catalogExports: { allowlistPath: ["mirror", "catalogs"] },
    reload: { configPrefixes: [MIRROR_CONFIG_PATH] },
    start(ctx) {
      const mirror = parseBeamMirrorConfig(params.runtime.config.current());
      if (mirror === undefined) {
        return;
      }
      if (typeof mirror === "string") {
        ctx.logger.warn(`beam mirror disabled: ${mirror}`);
        return;
      }
      if (!ctx.catalogExports) {
        ctx.logger.warn(
          "beam mirror disabled: this Gateway does not provide background catalog export",
        );
        return;
      }
      const active = createBeamMirrorRunner({
        catalogExports: ctx.catalogExports,
        resolveExecutable: params.resolveExecutable,
        // Bind each read and commit to the selected source and current caller.
        // A module-scoped handle survives an operator disconnect or catalog removal.
        getPublicationStore: (authority) =>
          params.runtime.state.openKeyedStoreV2<MirrorPublicationStoreValue>(
            { namespace: "mirror-publications", retention: "retained" },
            authority,
          ),
        getScheduleStore: (authority) =>
          params.runtime.state.openKeyedStoreV2<string>(
            { namespace: "mirror-schedule", maxEntries: 1024 },
            authority,
          ),
        runtime: params.runtime,
        logger: ctx.logger,
        signal: ctx.scheduler.signal,
      });
      params.onRunner?.(active);
      ctx.scheduler.signal.addEventListener("abort", () => params.onRunner?.(undefined), {
        once: true,
      });
      ctx.scheduler.schedule({
        id: "mirror",
        delayMs: 0,
        everyMs: mirror.pollSeconds * 1_000,
        run: () => active.tick(),
      });
      if (mirror.token === null) {
        ctx.logger.warn(
          `beam mirror paused: ${MIRROR_TOKEN_PATH} credential unavailable; restore it and run openclaw secrets reload`,
        );
      } else {
        ctx.logger.info(
          `beam mirror active: ${mirror.catalogs.join(", ")} -> ${new URL(mirror.endpoint).origin}`,
        );
      }
    },
  };
}

function isEnrollmentSource(value: unknown): value is BeamMirrorEnrollment {
  const fields = ["catalogId", "hostId", "threadId", "agentId", "sourceHomeId"] as const;
  return (
    isRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every(
      (field) =>
        typeof value[field] === "string" && value[field].length > 0 && value[field].length <= 500,
    )
  );
}

export function registerBeamMirror(
  api: OpenClawPluginApi,
  resolveExecutable: () => Promise<string>,
) {
  let active: ReturnType<typeof createBeamMirrorRunner> | undefined;
  api.registerService(
    createBeamMirrorService({
      runtime: api.runtime,
      resolveExecutable,
      onRunner: (runner) => {
        active = runner;
      },
    }),
  );
  api.registerGatewayMethod(
    "beam.mirror.enroll",
    async ({ params, respond, assertHandlerCurrent }) => {
      const authority = getGatewayRequestAuthorityV1();
      if (!authority?.scopes.includes("operator.admin") || !active) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Enable the Beam v2 mirror and connect as an administrator to enroll a source",
        });
        return;
      }
      if (
        !isRecord(params) ||
        Object.keys(params).some((key) => key !== "source" && key !== "confirmGeneration")
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Supply the exact source catalog, host, thread, agent and source home",
        });
        return;
      }
      const { source, confirmGeneration } = params;
      if (
        !isEnrollmentSource(source) ||
        (confirmGeneration !== undefined &&
          (typeof confirmGeneration !== "string" ||
            !confirmGeneration ||
            confirmGeneration.length > 256))
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Invalid Beam source locator or confirmed generation",
        });
        return;
      }
      try {
        const result = await active.enroll(
          source,
          {
            revalidate: () => authority.revalidate(),
            assertCurrent() {
              assertHandlerCurrent?.();
              authority.assertCurrent();
            },
          },
          confirmGeneration,
        );
        await authority.revalidate();
        authority.assertCurrent();
        respond(true, result);
      } catch {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message:
            "Beam enrollment did not complete. Verify the local source and original receiver. After token rotation, connect as the same publisher and repeat enrollment with its exact confirmGeneration.",
        });
      }
    },
    { scope: "operator.admin" },
  );
}
