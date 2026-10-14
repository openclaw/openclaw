import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

vi.mock("../runtime-api.js", () => ({ fetchWithSsrFGuard: vi.fn() }));

afterEach(() => {
  vi.mocked(fetchWithSsrFGuard).mockReset();
});

const cfg: CoreConfig = {
  channels: {
    "nextcloud-talk": {
      baseUrl: "https://cloud.example.test",
      botSecret: "fixture-secret",
      apiUser: "fixture-user",
      apiPassword: "fixture-password",
    },
  },
};

describe("Nextcloud Talk guarded response release", () => {
  it.each([
    {
      name: "successful reaction",
      status: 201,
      run: () => sendReactionNextcloudTalk("room:release", "42", "👍", { cfg }),
      expected: { ok: true },
    },
    {
      name: "failed room lookup",
      status: 404,
      run: () =>
        resolveNextcloudTalkRoomKind({
          account: resolveNextcloudTalkAccount({ cfg }),
          roomToken: "release-regression",
        }),
      expected: undefined,
    },
  ])("returns the $name result without waiting for body cancellation", async (testCase) => {
    const cancellation = createDeferred<void>();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel: () => cancellation.promise }),
      { status: testCase.status },
    );
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      release,
      finalUrl: "https://cloud.example.test",
    });
    const result = testCase.run();
    const waiting = Symbol("waiting for body cancellation");
    try {
      const observed = await Promise.race([
        result,
        new Promise<symbol>((resolve) => {
          setImmediate(() => resolve(waiting));
        }),
      ]);
      expect(observed).toEqual(testCase.expected);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      cancellation.resolve();
      await result;
      await response.body?.cancel();
    }
  });
});
