import { createHmac } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  FaceTimeHelperActionError,
  FaceTimeHelperAmbiguousError,
  FaceTimeHelperSocketServer,
  FaceTimeHelperUnavailableError,
} from "../src/helper-rpc.js";

const TEST_HELPER_AUTH_TOKEN = "a".repeat(64);
const TEST_HELPER_BUILD_ID = "b".repeat(64);

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve TCP port");
  }
  return address.port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

async function registerHelper(
  socket: net.Socket,
  helper: FaceTimeHelperSocketServer,
  bundleIdentifier: string,
  buildId: string | null = TEST_HELPER_BUILD_ID,
  expectConnected = true,
): Promise<string> {
  const challengePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("data", (chunk) => {
      try {
        resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
  socket.write(`${JSON.stringify({ event: "ping", bundle_identifier: bundleIdentifier })}\r\n`);
  const challenge = await challengePromise;
  const nonce = String(challenge.nonce);
  const processId = buildId === null ? 0 : 1234;
  const auth = createHmac("sha256", TEST_HELPER_AUTH_TOKEN)
    .update(
      buildId === null
        ? `helper\n${bundleIdentifier}\n${nonce}`
        : `helper\n${bundleIdentifier}\n${nonce}\n${buildId}\n${processId}`,
    )
    .digest("hex");
  socket.write(
    `${JSON.stringify({
      event: "auth-response",
      bundle_identifier: bundleIdentifier,
      ...(buildId === null ? {} : { build_id: buildId, process_id: processId }),
      nonce,
      auth,
    })}\r\n`,
  );
  if (expectConnected) {
    await waitFor(() => helper.connectedHelperBundles.includes(bundleIdentifier));
  }
  return nonce;
}

describe("FaceTime helper RPC", () => {
  let helper: FaceTimeHelperSocketServer | undefined;
  let client: net.Socket | undefined;

  afterEach(async () => {
    client?.destroy();
    await helper?.stop();
    client = undefined;
    helper = undefined;
  });

  it("sends set-muted actions over newline-framed JSON and resolves acknowledgements", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });

    const actionPromise = helper.setMuted("call-1", false);
    const payload = await received;
    expect(payload).toMatchObject({
      action: "set-muted",
      data: { callUUID: "call-1", muted: false },
    });
    expect(typeof payload.transactionId).toBe("string");

    client.write(
      `${JSON.stringify({
        transactionId: payload.transactionId,
        conversation_audio_started: true,
      })}\r\n`,
    );
    await expect(actionPromise).resolves.toMatchObject({
      transactionId: payload.transactionId,
      conversation_audio_started: true,
    });
  });

  it("sends leave-call actions over newline-framed JSON", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });

    const actionPromise = helper.leaveCall("call-2");
    const payload = await received;
    expect(payload).toMatchObject({
      action: "leave-call",
      data: { callUUID: "call-2" },
    });

    client.write(`${JSON.stringify({ transactionId: payload.transactionId })}\r\n`);
    await expect(actionPromise).resolves.toMatchObject({
      transactionId: payload.transactionId,
    });
  });

  it.each([
    ["answerCall", "answer-call"],
    ["leaveCall", "leave-call"],
  ] as const)("fans %s out to FaceTime and Phone helpers", async (method, action) => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    const faceTimeClient = net.createConnection({ host: "127.0.0.1", port });
    client = faceTimeClient;
    const phoneClient = net.createConnection({ host: "127.0.0.1", port });
    faceTimeClient.setEncoding("utf8");
    phoneClient.setEncoding("utf8");
    await Promise.all([
      new Promise<void>((resolve) => faceTimeClient.once("connect", resolve)),
      new Promise<void>((resolve) => phoneClient.once("connect", resolve)),
    ]);
    await registerHelper(faceTimeClient, helper, "com.apple.FaceTime");
    await registerHelper(phoneClient, helper, "com.apple.mobilephone");

    const readPayload = (socket: net.Socket) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.once("data", (chunk) => {
          try {
            resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
      });
    const payloadsPromise = Promise.all([readPayload(faceTimeClient), readPayload(phoneClient)]);
    const actionPromise = helper[method]("call-phone");
    const [faceTimePayload, phonePayload] = await payloadsPromise;
    expect(faceTimePayload).toMatchObject({
      action,
      data: { callUUID: "call-phone" },
    });
    expect(phonePayload).toMatchObject({
      action,
      data: { callUUID: "call-phone" },
    });

    faceTimeClient.write(
      `${JSON.stringify({
        transactionId: faceTimePayload.transactionId,
        error: "call not found",
      })}\r\n`,
    );
    phoneClient.write(
      `${JSON.stringify({
        transactionId: phonePayload.transactionId,
        handled: true,
      })}\r\n`,
    );

    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 2,
      helperResults: [expect.objectContaining({ handled: true })],
      handled: true,
    });
  });

  it("sends start-call actions with an explicit handle and mode", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    const authSession = await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });

    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "video" },
      "dial-1",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    expect(payload.action).toBe("start-call");
    expect(JSON.parse(String(payload.data_json))).toEqual({
      handle: "owner@example.com",
      mode: "video",
      dialID: "dial-1",
      requestedAt: "2026-07-20T17:52:00.000Z",
    });
    const expectedAuth = createHmac("sha256", TEST_HELPER_AUTH_TOKEN)
      .update(
        `action\n${String(payload.action)}\n${String(payload.transactionId)}\n${authSession}\n${String(payload.auth_nonce)}\n${String(payload.data_json)}`,
      )
      .digest("hex");
    expect(payload.auth_session).toBe(authSession);
    expect(payload.auth).toBe(expectedAuth);

    client.write(
      `${JSON.stringify({ transactionId: payload.transactionId, call_uuid: "call-3" })}\r\n`,
    );
    await expect(actionPromise).resolves.toMatchObject({ call_uuid: "call-3" });
  });

  it("distinguishes definitive helper rejection from transport failure", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "audio" },
      "dial-2",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    client.write(
      `${JSON.stringify({ transactionId: payload.transactionId, error: "cannot dial" })}\r\n`,
    );

    await expect(actionPromise).rejects.toBeInstanceOf(FaceTimeHelperActionError);
  });

  it("preserves helper-declared ambiguous dial outcomes", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "audio" },
      "dial-3",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    client.write(
      `${JSON.stringify({
        transactionId: payload.transactionId,
        error: "dial outcome is unknown",
        ambiguous: true,
        proxy_identifier: "proxy-3",
      })}\r\n`,
    );

    await expect(actionPromise).rejects.toMatchObject({
      name: "FaceTimeHelperAmbiguousError",
      result: { proxy_identifier: "proxy-3" },
    });
  });

  it("routes outbound calls to FaceTime regardless of helper connection order", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    const phoneClient = net.createConnection({ host: "127.0.0.1", port });
    client = phoneClient;
    phoneClient.setEncoding("utf8");
    await new Promise<void>((resolve) => phoneClient.once("connect", resolve));
    await registerHelper(phoneClient, helper, "com.apple.mobilephone");
    const faceTimeClient = net.createConnection({ host: "127.0.0.1", port });
    faceTimeClient.setEncoding("utf8");
    await new Promise<void>((resolve) => faceTimeClient.once("connect", resolve));
    await registerHelper(faceTimeClient, helper, "com.apple.FaceTime");

    let phoneReceivedAction = false;
    phoneClient.on("data", () => {
      phoneReceivedAction = true;
    });
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      faceTimeClient.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });

    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "video" },
      "dial-routed",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    faceTimeClient.write(
      `${JSON.stringify({ transactionId: payload.transactionId, call_uuid: "call-routed" })}\r\n`,
    );

    await expect(actionPromise).resolves.toMatchObject({ call_uuid: "call-routed" });
    expect(phoneReceivedAction).toBe(false);
    faceTimeClient.destroy();
  });

  it("reports a dial as definitely unsent when no helper is connected", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    await expect(
      helper.startCall(
        { handle: "owner@example.com", mode: "audio" },
        "dial-4",
        "2026-07-20T17:52:00.000Z",
      ),
    ).rejects.toBeInstanceOf(FaceTimeHelperUnavailableError);
  });

  it("rejects an authenticated stale helper and reports its process", async () => {
    const port = await reservePort();
    let staleHelper: { bundleIdentifier: string; processId: number } | undefined;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
      onStale: (bundleIdentifier, processId) => {
        staleHelper = { bundleIdentifier, processId };
      },
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime", "c".repeat(64), false);
    await waitFor(() => Boolean(staleHelper));

    expect(staleHelper).toEqual({
      bundleIdentifier: "com.apple.FaceTime",
      processId: 1234,
    });
    expect(helper.connectedSockets).toBe(0);
  });

  it("recognizes a pre-build-id helper as stale without trusting it", async () => {
    const port = await reservePort();
    let staleHelper: { bundleIdentifier: string; processId: number } | undefined;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
      onStale: (bundleIdentifier, processId) => {
        staleHelper = { bundleIdentifier, processId };
      },
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime", null, false);
    await waitFor(() => Boolean(staleHelper));

    expect(staleHelper).toEqual({
      bundleIdentifier: "com.apple.FaceTime",
      processId: 0,
    });
    expect(helper.connectedSockets).toBe(0);
  });

  it("queries the helper for an outgoing call by handle", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    const actionPromise = helper.findOutgoingCall("owner@example.com");
    const payload = await received;
    expect(payload).toMatchObject({
      action: "find-outgoing-call",
      data: { handle: "owner@example.com" },
    });
    client.write(
      `${JSON.stringify({ transactionId: payload.transactionId, found: true, call_uuid: "call-4" })}\r\n`,
    );
    await expect(actionPromise).resolves.toMatchObject({ found: true, call_uuid: "call-4" });
  });

  it("queries the helper for a known outgoing call UUID", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    const actionPromise = helper.findOutgoingCall(
      "owner@example.com",
      "call-3",
      "dial-5",
      "proxy-3",
    );
    const payload = await received;
    expect(payload).toMatchObject({
      action: "find-outgoing-call",
      data: {
        handle: "owner@example.com",
        callUUID: "call-3",
        dialID: "dial-5",
        proxyIdentifier: "proxy-3",
      },
    });
    client.write(
      `${JSON.stringify({ transactionId: payload.transactionId, found: true, call_uuid: "call-3" })}\r\n`,
    );
    await expect(actionPromise).resolves.toMatchObject({ found: true, call_uuid: "call-3" });
  });

  it("cancels an accepted outgoing call by its caller-generated dial ID", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client?.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    const actionPromise = helper.cancelOutgoingCall({
      dialID: "dial-6",
      handle: "owner@example.com",
      proxyIdentifier: "proxy-6",
    });
    const payload = await received;
    expect(payload).toMatchObject({
      action: "cancel-outgoing-call",
      data: {
        dialID: "dial-6",
        handle: "owner@example.com",
        proxyIdentifier: "proxy-6",
      },
    });
    client.write(
      `${JSON.stringify({ transactionId: payload.transactionId, found: true, cancelled: true })}\r\n`,
    );
    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 1,
      helperResults: [expect.objectContaining({ cancelled: true })],
    });
  });

  it("excludes unauthenticated sockets from call-control fanout", async () => {
    const port = await reservePort();
    let injectedEvents = 0;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => {
        injectedEvents += 1;
      },
    });
    await helper.start();

    const faceTimeClient = net.createConnection({ host: "127.0.0.1", port });
    client = faceTimeClient;
    faceTimeClient.setEncoding("utf8");
    await new Promise<void>((resolve) => faceTimeClient.once("connect", resolve));
    await registerHelper(faceTimeClient, helper, "com.apple.FaceTime");
    const rogueClient = net.createConnection({ host: "127.0.0.1", port });
    rogueClient.setEncoding("utf8");
    await new Promise<void>((resolve) => rogueClient.once("connect", resolve));
    rogueClient.write(
      `${JSON.stringify({
        event: "ft-call-status-changed",
        data: { call_uuid: "forged-call", call_status: 1 },
      })}\r\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(injectedEvents).toBe(0);

    let rogueReceivedAction = false;
    rogueClient.on("data", () => {
      rogueReceivedAction = true;
    });
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      faceTimeClient.once("data", (chunk) => {
        try {
          resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });

    const actionPromise = helper.cancelOutgoingCall({
      dialID: "dial-authenticated",
      handle: "owner@example.com",
      callUUID: "call-authenticated",
    });
    const payload = await received;
    faceTimeClient.write(
      `${JSON.stringify({ transactionId: payload.transactionId, cancelled: true })}\r\n`,
    );

    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 1,
      cancelled: true,
    });
    expect(rogueReceivedAction).toBe(false);
    rogueClient.destroy();
  });

  it("notifies when the last helper socket disconnects", async () => {
    const port = await reservePort();
    let disconnects = 0;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
      onDisconnect: () => {
        disconnects += 1;
      },
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => client?.once("connect", resolve));
    await registerHelper(client, helper, "com.apple.FaceTime");
    await waitFor(() => helper?.connectedSockets === 1);

    client.destroy();
    await waitFor(() => disconnects === 1);
    expect(helper.connectedSockets).toBe(0);
  });
});
