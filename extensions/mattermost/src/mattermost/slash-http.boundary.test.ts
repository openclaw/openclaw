import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { text } from "node:stream/consumers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";
import {
  activateSlashCommands,
  deactivateSlashCommands,
  registerSlashCommandRoute,
} from "./slash-state.js";

type SlashRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type HeldRequest = {
  socket: Socket;
  statusCode: number | undefined;
  endedByServer: boolean;
  closedByServer: boolean;
};

const CALLBACK_PATH = "/mattermost/slash";
const TOKEN = "boundary-token";

function createRuntime(dispatch: ReturnType<typeof vi.fn>) {
  return {
    channel: {
      commands: { shouldHandleTextCommands: () => true },
      inbound: { dispatch, ingress: createPluginRuntimeMock().channel.inbound.ingress },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({ code: "unused" }),
        buildPairingReply: () => "unused",
      },
      routing: {
        resolveAgentRoute: () => ({
          accountId: "default",
          agentId: "main",
          dmScope: "main",
          sessionKey: "agent:main:mattermost:channel:channel-1",
        }),
      },
      text: {
        hasControlCommand: () => false,
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => 4_000,
      },
    },
  };
}

function openHeldRequest(params: {
  port: number;
  localAddress: string;
  authorization?: string;
  contentLength?: number;
}): HeldRequest {
  const held: HeldRequest = {
    socket: connect({
      host: "127.0.0.1",
      port: params.port,
      localAddress: params.localAddress,
    }),
    statusCode: undefined,
    endedByServer: false,
    closedByServer: false,
  };
  let responseHead = "";
  held.socket.on("connect", () => {
    held.socket.write(
      [
        `POST ${CALLBACK_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${params.port}`,
        "Content-Type: application/x-www-form-urlencoded",
        `Content-Length: ${params.contentLength ?? 1}`,
        ...(params.authorization ? [`Authorization: ${params.authorization}`] : []),
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
  });
  held.socket.on("data", (chunk: Buffer) => {
    responseHead += chunk.toString("latin1");
    const match = responseHead.match(/^HTTP\/1\.1 (\d{3})/u);
    held.statusCode = match ? Number(match[1]) : undefined;
  });
  held.socket.on("end", () => (held.endedByServer = true));
  held.socket.on("close", () => (held.closedByServer = true));
  held.socket.on("error", () => {});
  return held;
}

async function postForm(params: {
  port: number;
  body: string;
  localAddress: string;
  authorization?: string;
}): Promise<{ statusCode: number; body: string }> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        localAddress: params.localAddress,
        path: CALLBACK_PATH,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(params.body),
          connection: "close",
          ...(params.authorization ? { authorization: params.authorization } : {}),
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end(params.body);
  });
  return { statusCode: response.statusCode ?? 0, body: await text(response) };
}

type Boundary = {
  address: { port: number };
  account: ResolvedMattermostAccount;
  command: MattermostRegisteredCommand;
  commandB: MattermostRegisteredCommand;
  currentCommands: Map<string, MattermostRegisteredCommand>;
  runtime: ReturnType<typeof createRuntime>;
  dispatch: ReturnType<typeof vi.fn>;
  errors: unknown[];
  routeRuns: Set<Promise<void>>;
  callbackSourceAddresses: string[];
  validBody: string;
  post: (command?: MattermostRegisteredCommand) => ReturnType<typeof postForm>;
  channelRequests: ReturnType<typeof vi.fn>;
  holdChannel: (gate: Promise<void>) => void;
};

async function withBoundary(runBoundary: (boundary: Boundary) => Promise<void>) {
  const registerHttpRoute =
    vi.fn<(route: { path: string; auth?: string; handler: SlashRouteHandler }) => void>();
  const dispatch = vi.fn(async (_params: unknown) => undefined);
  const runtime = createRuntime(dispatch);
  const currentCommands = new Map<string, MattermostRegisteredCommand>();
  const routeRuns = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const channelRequests = vi.fn();
  let channelGate: Promise<void> = Promise.resolve();
  setMattermostRuntime(runtime as never);
  registerSlashCommandRoute({
    config: {
      channels: { mattermost: { commands: { native: true, callbackPath: CALLBACK_PATH } } },
    },
    logger: { warn() {} },
    registerHttpRoute,
  } as never);

  expect(registerHttpRoute).toHaveBeenCalledWith(
    expect.objectContaining({ path: CALLBACK_PATH, auth: "plugin" }),
  );
  const slashRoute = registerHttpRoute.mock.calls.find(
    ([route]) => route.path === CALLBACK_PATH,
  )?.[0].handler;
  if (!slashRoute) {
    throw new Error("expected Mattermost to register its slash route");
  }

  const callbackSourceAddresses: string[] = [];
  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/api/v4/commands/")) {
      const command = currentCommands.get(req.url.slice("/api/v4/commands/".length));
      res.setHeader("content-type", "application/json");
      res.statusCode = command ? 200 : 404;
      res.end(
        JSON.stringify(
          command
            ? {
                id: command.id,
                team_id: command.teamId,
                trigger: command.trigger,
                method: "P",
                url: command.url,
                token: command.token,
                delete_at: 0,
              }
            : {},
        ),
      );
      return;
    }
    if (req.url?.startsWith("/api/v4/commands?")) {
      res.setHeader("content-type", "application/json");
      res.end("[]");
      return;
    }
    if (req.url === "/api/v4/channels/channel-1") {
      channelRequests();
      res.setHeader("content-type", "application/json");
      void channelGate.then(() =>
        res.end(
          JSON.stringify({
            id: "channel-1",
            name: "town-square",
            display_name: "Town Square",
            type: "O",
            team_id: "team-1",
          }),
        ),
      );
      return;
    }
    if (req.url === CALLBACK_PATH) {
      callbackSourceAddresses.push(req.socket.remoteAddress ?? "unknown");
      const run = slashRoute(req, res)
        .catch((error: unknown) => {
          errors.push(error);
          res.statusCode = 500;
          res.end("Injected handler failure");
        })
        .finally(() => routeRuns.delete(run));
      routeRuns.add(run);
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  };

  try {
    await withServer(handleRequest, async (baseUrl) => {
      const address = { port: Number(new URL(baseUrl).port) };
      const callbackUrl = `${baseUrl}${CALLBACK_PATH}`;

      const account: ResolvedMattermostAccount = {
        accountId: "default",
        enabled: true,
        botToken: "bot-token",
        botTokenSource: "config",
        baseUrl,
        baseUrlSource: "config",
        streamingMode: "partial",
        config: {
          groupPolicy: "open",
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      };
      const command: MattermostRegisteredCommand = {
        id: "command-1",
        teamId: "team-1",
        trigger: "oc_status",
        token: TOKEN,
        url: callbackUrl,
        managed: false,
      };
      const commandB = {
        ...command,
        id: "command-2",
        trigger: "oc_help",
        token: "boundary-token-b",
      };
      currentCommands.set(command.id, command);
      currentCommands.set(commandB.id, commandB);
      activateSlashCommands({
        account,
        commandTokens: [TOKEN, commandB.token],
        registeredCommands: [command, commandB],
        api: { cfg: {}, runtime: { log() {}, error() {}, exit() {} } },
      });

      const bodyFor = (selected = command) =>
        new URLSearchParams({
          token: selected.token,
          team_id: "team-1",
          channel_id: "channel-1",
          user_id: "user-1",
          user_name: "boundary-user",
          command: `/${selected.trigger}`,
          text: "hello",
          trigger_id: "trigger-1",
        }).toString();

      const validBody = bodyFor();
      await runBoundary({
        address,
        account,
        command,
        commandB,
        currentCommands,
        runtime,
        dispatch,
        errors,
        routeRuns,
        callbackSourceAddresses,
        validBody,
        post: (selected = command) =>
          postForm({
            port: address.port,
            localAddress: "127.0.0.1",
            authorization: `Token ${selected.token}`,
            body: bodyFor(selected),
          }),
        channelRequests,
        holdChannel: (gate: Promise<void>) => {
          channelGate = gate;
        },
      });
    });
  } finally {
    await Promise.all(routeRuns);
  }
}

async function fillCredentialPool(boundary: Boundary): Promise<HeldRequest[]> {
  const seen = boundary.callbackSourceAddresses.length;
  const held = holdPool(
    boundary.address.port,
    () => "127.0.0.1",
    () => `Token ${TOKEN}`,
  );
  await vi.waitFor(() => expect(boundary.callbackSourceAddresses).toHaveLength(seen + 8));
  expect(held.every((entry) => entry.statusCode === undefined)).toBe(true);
  await expectCredentialOverflow(boundary);
  return held;
}

async function expectCredentialOverflow(boundary: Boundary) {
  expect((await boundary.post()).statusCode).toBe(429);
}

function holdPool(
  port: number,
  address: (index: number) => string,
  authorization: (index: number) => string | undefined = () => undefined,
) {
  return Array.from({ length: 8 }, (_, index) =>
    openHeldRequest({ port, localAddress: address(index), authorization: authorization(index) }),
  );
}

function expectProcessing(response: Awaited<ReturnType<typeof postForm>>) {
  expect(response).toEqual({
    statusCode: 200,
    body: JSON.stringify({ response_type: "ephemeral", text: "Processing..." }),
  });
}

async function drainCredentialPool(held: HeldRequest[], timeout = 1_000) {
  for (const entry of held) {
    entry.socket.write("x");
  }
  await vi.waitFor(
    () => expect(held.map((entry) => entry.statusCode)).toEqual(Array(8).fill(400)),
    { timeout },
  );
}

describe("Mattermost slash HTTP boundary", () => {
  afterEach(() => {
    deactivateSlashCommands();
  });

  it("reserves authenticated capacity and bounds each pre-authentication pool at eight", async () => {
    await withBoundary(async ({ address, callbackSourceAddresses, validBody, dispatch }) => {
      const sharedHeld = holdPool(
        address.port,
        (index) => `127.0.0.${index + 2}`,
        (index) =>
          index === 6 ? "Token wrong-token" : index === 7 ? `Bearer ${TOKEN}` : undefined,
      );
      await vi.waitFor(() => expect(callbackSourceAddresses).toHaveLength(8), { timeout: 3_000 });
      expect(sharedHeld.every((entry) => entry.statusCode === undefined)).toBe(true);

      const sharedOverflow = openHeldRequest({ port: address.port, localAddress: "127.0.0.10" });
      await vi.waitFor(() => expect(sharedOverflow.statusCode).toBe(429), { timeout: 3_000 });
      await vi.waitFor(
        () => expect(sharedOverflow.endedByServer && sharedOverflow.closedByServer).toBe(true),
        { timeout: 3_000 },
      );

      expectProcessing(
        await postForm({
          port: address.port,
          body: validBody,
          localAddress: "127.0.0.11",
          authorization: `Token ${TOKEN}`,
        }),
      );
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

      await drainCredentialPool(sharedHeld, 3_000);

      const authenticatedHeld = holdPool(
        address.port,
        (index) => `127.0.0.${index + 21}`,
        () => `Token ${TOKEN}`,
      );
      await vi.waitFor(() => expect(callbackSourceAddresses).toHaveLength(18), { timeout: 3_000 });
      expect(authenticatedHeld.every((entry) => entry.statusCode === undefined)).toBe(true);
      const authenticatedOverflow = openHeldRequest({
        port: address.port,
        localAddress: "127.0.0.29",
        authorization: `Token ${TOKEN}`,
      });
      await vi.waitFor(() => expect(authenticatedOverflow.statusCode).toBe(429), {
        timeout: 3_000,
      });

      const recovered = await postForm({
        port: address.port,
        body: "x",
        localAddress: "127.0.0.30",
      });
      expect(recovered.statusCode).toBe(400);
      await drainCredentialPool(authenticatedHeld, 3_000);

      expect(new Set(callbackSourceAddresses).size).toBe(callbackSourceAddresses.length);
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        channel: "mattermost",
        accountId: "default",
        ctxPayload: {
          Body: "/status hello",
          SenderId: "user-1",
          InboundAccessAuthorized: true,
        },
      });
    });
  }, 20_000);
  it("keeps B admitted when eight stalled revoked A credentials fill A capacity in one account", async () => {
    await withBoundary(async (boundary) => {
      const { command, commandB, currentCommands, dispatch } = boundary;
      currentCommands.delete(command.id);
      // Upstream changes leave the activation token snapshot intact until restart.
      expect((await boundary.post()).statusCode).toBe(401);
      const held = await fillCredentialPool(boundary);
      expectProcessing(await boundary.post(commandB));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      await drainCredentialPool(held);
    });
  });

  it("releases exactly once when overlapping authenticated work throws", async () => {
    await withBoundary(async (boundary) => {
      const gate = createDeferred<void>();
      boundary.holdChannel(gate.promise);
      boundary.runtime.channel.commands.shouldHandleTextCommands = () => {
        throw new Error("injected post-authentication failure");
      };
      const pending = Array.from({ length: 2 }, () => boundary.post());
      try {
        await vi.waitFor(() => expect(boundary.channelRequests).toHaveBeenCalledTimes(2));
        const oldRuns = [...boundary.routeRuns];
        expect(oldRuns).toHaveLength(2);
        // Both old handlers have authenticated but are still awaiting channel work.
        const held = await fillCredentialPool(boundary);
        gate.resolve();
        const completed = await Promise.all(pending);
        expect(completed.map((response) => response.statusCode)).toEqual([500, 500]);
        await Promise.all(oldRuns);
        expect(boundary.errors).toHaveLength(2);
        // Old finally blocks must not release any of the eight newer admissions.
        await expectCredentialOverflow(boundary);
        await drainCredentialPool(held);
        await drainCredentialPool(await fillCredentialPool(boundary));
      } finally {
        gate.resolve();
        await Promise.allSettled(pending);
      }
    });
  });

  it.each(["throw before authentication", "timeout", "oversize", "disconnect"])(
    "refills authenticated capacity to eight after %s",
    async (fault) => {
      await withBoundary(async (boundary) => {
        if (fault === "throw before authentication") {
          const baseUrl = boundary.account.baseUrl;
          boundary.account.baseUrl = "";
          const result = await boundary.post();
          boundary.account.baseUrl = baseUrl;
          expect(result.statusCode).toBe(500);
          expect(boundary.errors).toHaveLength(1);
        } else {
          const failed = openHeldRequest({
            port: boundary.address.port,
            localAddress: "127.0.0.1",
            authorization: `Token ${TOKEN}`,
            contentLength: fault === "oversize" ? 65_537 : 1,
          });
          await vi.waitFor(() => expect(boundary.callbackSourceAddresses).toHaveLength(1));
          if (fault === "disconnect") {
            failed.socket.destroy();
          } else {
            await vi.waitFor(
              () => expect(failed.statusCode).toBe(fault === "timeout" ? 408 : 413),
              { timeout: 7_000 },
            );
            await vi.waitFor(() => expect(failed.closedByServer).toBe(true));
          }
        }
        await vi.waitFor(() => expect(boundary.routeRuns.size).toBe(0));
        expect(boundary.channelRequests).not.toHaveBeenCalled();
        await drainCredentialPool(await fillCredentialPool(boundary));
      });
    },
    15_000,
  );
});
