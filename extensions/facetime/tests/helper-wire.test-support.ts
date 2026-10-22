import { createHmac } from "node:crypto";
import { once } from "node:events";
import type net from "node:net";
import { expect } from "vitest";

export type Payload = Record<string, unknown>;
export const TEST_HELPER_AUTH_TOKEN = "a".repeat(64);
export const TEST_HELPER_BUILD_ID = "b".repeat(64);
const hmac = (key: string, message: string) =>
  createHmac("sha256", key).update(message).digest("hex");

export function writeFrame(socket: net.Socket, payload: Payload, lineEnding = "\r\n") {
  socket.write(`${JSON.stringify(payload)}${lineEnding}`);
}

export class HelperClient {
  private incomingSequence = 0;
  private outgoingSequence = 0;
  private epoch = "";
  private key = "";

  constructor(
    readonly socket: net.Socket,
    private readonly readFrame = async (): Promise<Payload> => {
      const [chunk] = await once(socket, "data");
      return JSON.parse(String(chunk).trim()) as Payload;
    },
    private readonly lineEnding = "\r\n",
  ) {}

  decode(envelope: Payload): Payload {
    const sequence = Number(envelope.sequence);
    const json = String(envelope.payload_json);
    expect(envelope).toMatchObject({
      connection_epoch: this.epoch,
      direction: "server-to-helper",
      sequence: this.incomingSequence + 1,
      auth: hmac(this.key, `message\nserver-to-helper\n${this.epoch}\n${sequence}\n${json}`),
    });
    this.incomingSequence = sequence;
    return JSON.parse(json) as Payload;
  }

  async read(): Promise<Payload> {
    return this.decode(await this.readFrame());
  }

  encode(payload: Payload): string {
    const json = JSON.stringify(payload);
    const sequence = ++this.outgoingSequence;
    return `${JSON.stringify({
      connection_epoch: this.epoch,
      sequence,
      direction: "helper-to-server",
      payload_json: json,
      auth: hmac(this.key, `message\nhelper-to-server\n${this.epoch}\n${sequence}\n${json}`),
    })}${this.lineEnding}`;
  }

  send(payload: Payload) {
    this.socket.write(this.encode(payload));
  }

  async exchange<T>(send: () => Promise<T>, expected: Payload, reply: Payload) {
    const received = this.read();
    const result = send();
    const payload = await received;
    expect(payload).toMatchObject({ ...expected, transactionId: expect.any(String) });
    this.send({ transactionId: payload.transactionId, ...reply });
    return { result, payload };
  }

  async authenticate(
    beforeAck = () => {},
    bundle = "com.apple.FaceTime",
    processId = 1234,
    buildId = TEST_HELPER_BUILD_ID,
  ): Promise<boolean> {
    const started = 1_700_000_000_000;
    const nonce = "c".repeat(64);
    writeFrame(
      this.socket,
      {
        event: "client-hello",
        bundle_identifier: bundle,
        build_id: buildId,
        process_id: processId,
        process_started_at_ms: started,
        client_nonce: nonce,
        proof: hmac(
          TEST_HELPER_AUTH_TOKEN,
          `client-hello\n${bundle}\n${buildId}\n${processId}\n${started}\n${nonce}`,
        ),
      },
      this.lineEnding,
    );
    if (buildId !== TEST_HELPER_BUILD_ID) {
      return false;
    }
    const hello = await this.readFrame();
    this.epoch = String(hello.connection_epoch);
    const context = `${bundle}\n${buildId}\n${processId}\n${started}\n${nonce}\n${String(hello.server_nonce)}\n${this.epoch}`;
    expect(hello).toMatchObject({
      event: "server-hello",
      client_nonce: nonce,
      proof: hmac(TEST_HELPER_AUTH_TOKEN, `server-hello\n${context}`),
    });
    this.key = hmac(TEST_HELPER_AUTH_TOKEN, `session\n${context}`);
    writeFrame(
      this.socket,
      {
        event: "client-finish",
        connection_epoch: this.epoch,
        proof: hmac(this.key, `client-finish\n${this.epoch}`),
      },
      this.lineEnding,
    );
    await expect(this.read()).resolves.toEqual({ event: "session-ready" });
    beforeAck();
    this.send({ event: "session-ready-ack" });
    return true;
  }
}
