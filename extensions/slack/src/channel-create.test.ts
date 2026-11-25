import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const createdChannel = { id: "C01234567", name: "proj-launch-pixel-peak" };
const createRequest = {
  channel: "slack" as const,
  action: "channel-create" as const,
  cfg: { channels: { slack: { botToken: "xoxb-test", actions: { channels: true } } } },
  params: { name: createdChannel.name },
  accountId: "default",
  requesterAccountId: "default",
  requesterSenderId: "U22222222",
  toolContext: {
    currentChannelProvider: "slack",
    currentChannelId: "team:T11111111:channel:C09999999",
  },
};
const created = {
  ok: true,
  channelId: createdChannel.id,
  name: createdChannel.name,
  target: "team:T11111111:channel:C01234567",
};
const expectedRequests = [
  { method: "conversations.create", args: { name: createdChannel.name, team_id: "T11111111" } },
  { method: "conversations.invite", args: { channel: createdChannel.id, users: "U22222222" } },
];
type ActionContext = Parameters<
  NonNullable<ReturnType<typeof createSlackActions>["handleAction"]>
>[0];
const create = (overrides: Partial<ActionContext> = {}) =>
  createSlackActions("slack").handleAction!({ ...createRequest, ...overrides });

async function withChannelServer(
  respond: (method: string, args: Record<string, string>) => unknown,
  use: () => Promise<void>,
) {
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  await withServer(
    (request, response) => {
      const body: Buffer[] = [];
      request.on("data", (chunk: Buffer) => body.push(chunk));
      request.on("end", () => {
        const result = respond(
          request.url?.split("/").at(-1) ?? "",
          Object.fromEntries(new URLSearchParams(Buffer.concat(body).toString())),
        );
        if (result !== undefined) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        }
      });
    },
    async (baseUrl) => {
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      await use();
    },
  );
}

describe("Slack channel-create", () => {
  it("returns the created channel when Slack cannot invite the requester", async () => {
    await withChannelServer(
      (method) =>
        method === "conversations.create"
          ? { ok: true, channel: createdChannel }
          : { ok: false, error: "missing_scope" },
      async () => {
        expect((await create()).details).toEqual({
          ...created,
          inviteWarning:
            "Slack is missing the invitation permission; the requesting user can join the returned public channel, or an operator can reauthorize the Slack app and retry.",
        });
      },
    );
  });

  it("keeps Enterprise workspace admission at the real HTTP boundary while omitting team_id from invitation serialization", async () => {
    const requests: Array<{ method: string; args: Record<string, string> }> = [];
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      await withChannelServer(
        (method, args) => {
          requests.push({ method, args });
          return method === "conversations.create"
            ? { ok: true, channel: { id: "C01234567", name: args.name } }
            : { ok: true };
        },
        async () => {
          expect((await create()).details).toEqual({ ...created, invitedUserId: "U22222222" });
          await expect(
            create({
              toolContext: { currentChannelProvider: "slack", currentChannelId: "C09999999" },
            }),
          ).rejects.toThrow("unsupported_enterprise_slack_delivery");
          await expect(
            create({
              toolContext: {
                ...createRequest.toolContext,
                currentMessagingTarget: "team:T22222222:channel:C09999999",
              },
            }),
          ).rejects.toThrow("unsupported_enterprise_slack_delivery");
        },
      );
      expect(requests).toEqual(expectedRequests);
    } finally {
      installation.release();
    }
  });

  it("does not invite the requester after caller authority closes during creation", async () => {
    let active = true;
    const assertDirectAdapterHandoff = () => {
      if (!active) {
        throw new Error("direct delivery is no longer active");
      }
    };
    const methods: string[] = [];
    await withChannelServer(
      (method) => {
        methods.push(method);
        if (method === "conversations.create") {
          active = false;
          return { ok: true, channel: createdChannel };
        }
        return undefined;
      },
      async () => {
        const result = await create({ assertDirectAdapterHandoff });
        expect(result.details).toMatchObject({
          ok: true,
          channelId: "C01234567",
          inviteWarning:
            "Slack rejected the invitation; the requesting user can join the returned public channel, or an operator can reauthorize the Slack app and retry.",
        });
      },
    );
    expect(methods).toEqual(["conversations.create"]);
  });
});
