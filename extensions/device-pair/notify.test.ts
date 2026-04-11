import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const listDevicePairingMock = vi.hoisted(() => vi.fn(async () => ({ pending: [] })));

vi.mock("./api.js", () => ({
  listDevicePairing: listDevicePairingMock,
}));

import { handleNotifyCommand } from "./notify.js";

describe("device-pair notify persistence", () => {
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    await fs.writeFile(
      path.join(stateDir, "device-pair-notify.json"),
      JSON.stringify(
        {
          subscribers: [
            {
              to: "chat-123",
              accountId: "telegram-default",
              messageThreadId: 271,
              mode: "persistent",
              addedAtMs: 1,
            },
          ],
          notifiedRequestIds: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const api = createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
      } as never,
    });

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "status",
    });

    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "off",
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { subscribers: unknown[] };
    expect(persisted.subscribers).toEqual([]);
  });
});
