import { expect, it } from "vitest";
import { isSignalQuoteMetadataRejection } from "./quote-rejection.js";
import { sendMessageSignal } from "./send.js";
import {
  listenSignalServer,
  signalJsonServer,
  type SignalRpcEnvelope,
} from "./signal-rpc.test-support.js";

const recipient = "+15551234567";
const author = "bad-author";
const invalidNumber = (value: string) => `Invalid phone number '${value}': Invalid number`;
const cases = [
  [invalidNumber(author), true],
  ["Quote author parameter is missing", true],
  [invalidNumber(recipient), false],
  ["Invalid attachment dimensions syntax", false],
  ["Timestamp must be positive", false],
] as const;

it.each([
  ["Signal RPC -32602: Invalid quoteTimestamp", true],
  ["Signal RPC -32603: Invalid quoteTimestamp", false],
  ["Signal RPC -1: Invalid attachment dimensions syntax (quote)", false],
  ["Signal REST 429: Invalid quote timestamp", false],
  ["Signal RPC -1: quote metadata rejected (redacted)", true],
  ["Signal REST 400: " + invalidNumber(author), true],
])("classifies provider rejection %s", (message, expected) => {
  expect(
    isSignalQuoteMetadataRejection(message, { quoteAuthor: author, recipient: [recipient] }),
  ).toBe(expected);
});

for (const kind of ["external-native", "container"] as const) {
  it.each(cases)(`${kind} retries only rejected quote metadata: %s`, async (message, retry) => {
    const requests: SignalRpcEnvelope[] = [];
    await using server = signalJsonServer((payload, _request, res) => {
      requests.push(payload);
      const first = requests.length === 1;
      res.writeHead(kind === "container" && first ? 400 : 200);
      res.end(
        JSON.stringify(
          kind === "container"
            ? first
              ? { error: message }
              : { timestamp: "1700000000002" }
            : {
                jsonrpc: "2.0",
                id: payload.id,
                ...(first
                  ? { error: { code: -1, message } }
                  : { result: { timestamp: 1700000000002 } }),
              },
        ),
      );
    });
    const cfg = await listenSignalServer(server, kind);
    const delivery = sendMessageSignal(recipient, "reply", {
      cfg,
      textMode: "plain",
      replyToId: "1700000000001",
      replyToAuthor: author,
    });
    if (retry) {
      await expect(delivery).resolves.toMatchObject({
        messageId: "1700000000002",
        receipt: { raw: [{ meta: { nativeReplyStatus: "fallback" } }] },
      });
      const sent = kind === "container" ? requests[1] : requests[1]?.params;
      expect(sent).not.toHaveProperty(kind === "container" ? "quote_author" : "quoteAuthor");
      expect(sent).toMatchObject({ message: "reply" });
    } else {
      await expect(delivery).rejects.toThrow("Signal ");
    }
    expect(requests).toHaveLength(retry ? 2 : 1);
  });
}

// The same error value can be a recipient, not the quote author: never replay it.
it("does not retry an invalid recipient that also authored the quote", async () => {
  let count = 0;
  await using server = signalJsonServer((payload, _request, res) => {
    count += 1;
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -1, message: invalidNumber(recipient) },
      }),
    );
  });
  const cfg = await listenSignalServer(server);
  await expect(
    sendMessageSignal(recipient, "reply", {
      cfg,
      replyToId: "1700000000001",
      replyToAuthor: recipient,
    }),
  ).rejects.toThrow("Invalid phone number");
  expect(count).toBe(1);
});
