import { readFile, writeFile } from "node:fs/promises";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";
import * as client from "./client-adapter.js";

describe("Signal outbound non-positive mediaMaxMb", () => {
  it.each([0, -5])("falls back to the default cap when mediaMaxMb is %s", async (mediaMaxMb) => {
    const state = await createOpenClawTestState({ prefix: "signal-media-nonpositive-" });
    const delivered: Buffer[] = [];
    const request = vi
      .spyOn(client, "signalRpcRequest")
      .mockImplementation(async (_method, params) => {
        const attachment = Array.isArray(params?.attachments) ? params.attachments[0] : undefined;
        if (typeof attachment !== "string") {
          throw new Error("Missing native attachment path");
        }
        delivered.push(await readFile(attachment));
        return { timestamp: 1234567890 };
      });
    try {
      const bytes = Buffer.from("%PDF-1.4\nsmall attachment");
      const file = state.path("small.pdf");
      await writeFile(file, bytes);
      const transport = { kind: "external-native" as const, url: "http://signal.test" };
      const params = {
        cfg: {
          channels: {
            signal: {
              account: "+15550001111",
              transport,
              mediaMaxMb,
            },
          },
        },
        to: "+15555550123",
        text: "",
        mediaLocalRoots: [state.root],
        mediaUrl: file,
      };
      const send = signalPlugin.outbound?.sendMedia;
      if (!send) {
        throw new Error("Missing Signal media sender");
      }
      const result = await send(params);
      expect(result.messageId).toBe("1234567890");
      expect(delivered).toEqual([bytes]);
    } finally {
      request.mockRestore();
      await state.cleanup();
    }
  });
});
