import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import {
  getCodexControllerContext,
  isProposalStatus,
  parseExportFormat,
  parseLimit,
} from "./commands-shared.js";
import type { CodexNativeController } from "./controller.js";

type GatewayRespond = (
  ok: boolean,
  payload?: unknown,
  error?: { code: string; message: string; details?: unknown; retryable?: boolean },
  meta?: Record<string, unknown>,
) => void;

export function registerCodexGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod("codex.status", async ({ respond }) => {
    await withGatewayController(api, respond, async (controller) => controller.status());
  });
  api.registerGatewayMethod("codex.routes", async ({ respond }) => {
    await withGatewayController(api, respond, async (controller) => ({
      routes: controller.listRoutes(),
      defaultRoute: controller.config.defaultRoute,
    }));
  });
  api.registerGatewayMethod("codex.sessions", async ({ params, respond }) => {
    await withGatewayController(api, respond, async (controller) =>
      controller.listSessions(parseLimit(params.limit, 20)),
    );
  });
  api.registerGatewayMethod("codex.events", async ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "codex.events requires sessionKey",
      });
      return;
    }
    await withGatewayController(api, respond, async (controller) =>
      controller.listEvents(sessionKey, parseLimit(params.limit, 80)),
    );
  });
  api.registerGatewayMethod("codex.session.export", async ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "codex.session.export requires sessionKey",
      });
      return;
    }
    await withGatewayController(api, respond, async (controller) =>
      controller.exportSession(sessionKey, {
        format: parseExportFormat(params.format),
        limit: parseLimit(params.limit, 400, 1000),
      }),
    );
  });
  api.registerGatewayMethod("codex.inbox", async ({ params, respond }) => {
    await withGatewayController(api, respond, async (controller) =>
      controller.listInbox(parseLimit(params.limit, 20)),
    );
  });
  api.registerGatewayMethod("codex.proposal.create", async ({ params, respond }) => {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (!title) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "codex.proposal.create requires title",
      });
      return;
    }
    await withGatewayController(api, respond, async (controller) =>
      controller.createProposal({
        title,
        ...(typeof params.summary === "string" && params.summary.trim()
          ? { summary: params.summary.trim() }
          : {}),
        ...(typeof params.body === "string" && params.body.trim()
          ? { body: params.body.trim() }
          : {}),
        ...(Array.isArray(params.actions)
          ? {
              actions: params.actions
                .filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                )
                .map((entry) => entry.trim()),
            }
          : {}),
        ...(typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? { sessionKey: params.sessionKey.trim() }
          : {}),
        ...(typeof params.routeId === "string" && params.routeId.trim()
          ? { routeId: params.routeId.trim() }
          : {}),
        ...(typeof params.routeLabel === "string" && params.routeLabel.trim()
          ? { routeLabel: params.routeLabel.trim() }
          : {}),
      }),
    );
  });
  api.registerGatewayMethod("codex.proposal.update", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const status = typeof params.status === "string" ? params.status.trim() : "";
    if (!id || !isProposalStatus(status)) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "codex.proposal.update requires id and status=new|accepted|dismissed",
      });
      return;
    }
    await withGatewayController(api, respond, async (controller) =>
      controller.updateInbox(id, status),
    );
  });
  api.registerGatewayMethod("codex.proposal.execute", async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "codex.proposal.execute requires id",
      });
      return;
    }
    await withGatewayController(api, respond, async (controller) =>
      controller.executeProposal(id, {
        ...(typeof params.route === "string" && params.route.trim()
          ? { route: params.route.trim() }
          : {}),
        ...(typeof params.cwd === "string" && params.cwd.trim() ? { cwd: params.cwd.trim() } : {}),
        ...(typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? { sessionKey: params.sessionKey.trim() }
          : {}),
        ...(params.mode === "persistent" || params.mode === "oneshot" ? { mode: params.mode } : {}),
      }),
    );
  });
  api.registerGatewayMethod("codex.doctor", async ({ params, respond }) => {
    await withGatewayController(api, respond, async (controller) =>
      controller.doctor(params.record === true),
    );
  });
}

async function withGatewayController<T>(
  api: OpenClawPluginApi,
  respond: GatewayRespond,
  fn: (controller: CodexNativeController) => Promise<T> | T,
): Promise<void> {
  try {
    respond(true, await fn(getCodexControllerContext(api)), undefined);
  } catch (error) {
    respond(false, undefined, {
      code: "CODEX_SDK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
