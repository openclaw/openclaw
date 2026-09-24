import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import type { ClawdbotConfig } from "../runtime-api.js";

export const AUTH_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
export const MESSAGE_PATH = "/open-apis/im/v1/messages";
export const FILE_PATH = "/open-apis/im/v1/files";
export const COMMENT_PATH = "/open-apis/drive/v1/files/doc_fixture/comments";
export const TARGET = "oc_delivery";

type WireRequest = { method: string; path: string; body: string };

export async function withFeishuTransport(
  run: (fixture: {
    cfg: ClawdbotConfig;
    requests: WireRequest[];
    gate: () => ReturnType<typeof createDeferred<void>>;
    track: <T>(operation: Promise<T>) => Promise<T>;
    intercept: (pathname: string, wait: () => Promise<void>) => void;
    respond: (
      handler: (request: WireRequest, response: ServerResponse) => Promise<boolean>,
    ) => void;
  }) => Promise<void>,
) {
  const requests: WireRequest[] = [];
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const interceptors: number[] = [];
  let handleRequest: (
    request: WireRequest,
    response: ServerResponse,
  ) => Promise<boolean> = async () => false;
  await withServer(
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const record: WireRequest = {
          method: request.method ?? "",
          path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(record);
        if (await handleRequest(record, response)) {
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            record.path === AUTH_PATH
              ? { code: 0, tenant_access_token: "loopback-token", expire: 7200 }
              : record.path === FILE_PATH
                ? { code: 0, data: { file_key: "file_uploaded" } }
                : record.path === `${COMMENT_PATH}/batch_query`
                  ? {
                      code: 0,
                      data: { items: [{ comment_id: "comment_fixture", is_whole: false }] },
                    }
                  : record.path === `${COMMENT_PATH}/comment_fixture/replies`
                    ? { code: 0, data: { reply_id: "reply_accepted" } }
                    : { code: 0, data: { message_id: "om_accepted", chat_id: TARGET } },
          ),
        );
      })().catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    },
    async (origin) => {
      const cfg: ClawdbotConfig = {
        channels: {
          feishu: {
            enabled: true,
            appId: `cli_delivery_${randomUUID()}`,
            appSecret: "loopback-placeholder", // pragma: allowlist secret
            domain: origin,
            renderMode: "raw",
          },
        },
      };
      try {
        await run({
          cfg,
          requests,
          gate: () => {
            const gate = createDeferred<void>();
            releases.push(() => gate.resolve());
            return gate;
          },
          track: (operation) => {
            pending.push(operation);
            return operation;
          },
          intercept: (pathname, wait) => {
            interceptors.push(
              Lark.defaultHttpInstance.interceptors.request.use(async (options) => {
                if (new URL(options.url ?? "").pathname === pathname) {
                  await wait();
                }
                return options;
              }),
            );
          },
          respond: (handler) => {
            handleRequest = handler;
          },
        });
      } finally {
        for (const release of releases) {
          release();
        }
        await Promise.allSettled(pending);
        for (const interceptor of interceptors) {
          Lark.defaultHttpInstance.interceptors.request.eject(interceptor);
        }
      }
    },
  );
}

export function readFeishuQueueState(stateDir: string, id: string) {
  const database = openNodeSqliteDatabase(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        "SELECT status, recovery_state FROM delivery_queue_entries WHERE queue_name = 'outbound-prepared-v1' AND id = ?",
      )
      .get(id);
  } finally {
    database.close();
  }
}
