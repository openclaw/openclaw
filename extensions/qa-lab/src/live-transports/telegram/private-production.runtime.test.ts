import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTelegramPrivateProductionDescriptor,
  requestTelegramPrivateAppTurn,
} from "./private-production.runtime.js";

const roots: string[] = [];

function writeDescriptor() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-private-apps-test-"));
  roots.push(root);
  const file = path.join(root, "descriptor.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      mode: "private-production-local-apps",
      forumGroupId: "-100456",
      forumTopicId: 42,
      topicTitle: "Private proof",
      participants: [
        { alias: "primary", host: "mainframe", userId: "100" },
        { alias: "second", host: "macbook", userId: "101" },
      ],
    }),
    { mode: 0o600 },
  );
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Telegram private production local-app proof", () => {
  it("parses two distinct operator-local participants without credential material", () => {
    const file = writeDescriptor();

    expect(readTelegramPrivateProductionDescriptor(file)).toEqual({
      file,
      mode: "private-production-local-apps",
      forumGroupId: "-100456",
      forumTopicId: 42,
      topicTitle: "Private proof",
      participants: [
        { alias: "primary", host: "mainframe", userId: "100" },
        { alias: "second", host: "macbook", userId: "101" },
      ],
    });
  });

  it("accepts a native UI acknowledgement without placing raw participant IDs in the handoff", async () => {
    const file = writeDescriptor();
    const descriptor = readTelegramPrivateProductionDescriptor(file)!;
    const pending = requestTelegramPrivateAppTurn({
      descriptor,
      destination: "forum-topic",
      participant: descriptor.participants[1]!,
      text: "@qa_bot Reply exactly: marker",
    });
    const proofRoot = `${file}.app-proof`;
    let requestPath: string | undefined;
    for (let attempts = 0; attempts < 100 && !requestPath; attempts += 1) {
      requestPath = fs.existsSync(proofRoot)
        ? fs
            .readdirSync(proofRoot)
            .map((entry) => path.join(proofRoot, entry))
            .find((entry) => entry.endsWith(".request.json"))
        : undefined;
      if (!requestPath) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    }
    expect(requestPath).toBeDefined();
    const requestText = fs.readFileSync(requestPath!, "utf8");
    expect(requestText).not.toContain('"100"');
    expect(requestText).not.toContain('"101"');
    const request = JSON.parse(requestText) as {
      destination: string;
      text: string;
      token: string;
    };
    fs.writeFileSync(
      path.join(proofRoot, `${request.token}.ack.json`),
      JSON.stringify({
        schemaVersion: 1,
        token: request.token,
        sentText: request.text,
        replyText: "marker",
        replyObservedIn: request.destination,
        replyToRequestedMessage: true,
      }),
      { mode: 0o600 },
    );

    await expect(pending).resolves.toEqual({ replyText: "marker" });
    expect(fs.readdirSync(proofRoot)).toEqual([]);
  });
});
