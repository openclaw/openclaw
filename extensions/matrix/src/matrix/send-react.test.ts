/**
 * Regression tests: reactMatrixMessage must accept and forward accountId
 * to resolveMatrixClient, consistent with the other action functions.
 *
 * Before fix: signature was (roomId, messageId, emoji, client?) — no accountId.
 * After fix: signature is (roomId, messageId, emoji, opts?) where opts includes accountId.
 *
 * See: openclaw/openclaw#26457
 */
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared outside it
vi.mock("./send/client.js", () => ({
  resolveMatrixClient: vi.fn(),
  resolveMediaMaxBytes: vi.fn().mockReturnValue(10 * 1024 * 1024),
}));

vi.mock("./send/targets.js", () => ({
  resolveMatrixRoomId: vi.fn().mockImplementation((_client: unknown, to: string) => to),
  normalizeThreadId: vi.fn().mockImplementation((id: unknown) => id),
}));

vi.mock("@vector-im/matrix-bot-sdk", () => ({
  MatrixClient: vi.fn(),
}));

import { reactMatrixMessage } from "./send.js";
import * as clientModule from "./send/client.js";

const resolveMatrixClientMock = vi.mocked(clientModule.resolveMatrixClient);

const fakeClient = {
  stop: vi.fn(),
  sendEvent: vi.fn().mockResolvedValue("$reaction-evt"),
} as unknown as MatrixClient;

beforeEach(() => {
  resolveMatrixClientMock.mockClear();
  resolveMatrixClientMock.mockResolvedValue({ client: fakeClient, stopOnDone: false });
  (fakeClient.stop as ReturnType<typeof vi.fn>).mockClear();
  (fakeClient.sendEvent as ReturnType<typeof vi.fn>).mockClear();
});

describe("reactMatrixMessage — accountId forwarding", () => {
  it("forwards accountId to resolveMatrixClient when provided", async () => {
    await reactMatrixMessage("!room:matrix.org", "$evt1", "👍", { accountId: "neko" });

    expect(resolveMatrixClientMock).toHaveBeenCalledOnce();
    expect(resolveMatrixClientMock.mock.calls[0][0]).toMatchObject({ accountId: "neko" });
  });

  it("forwards undefined accountId (no regression for single-account setups)", async () => {
    await reactMatrixMessage("!room:matrix.org", "$evt1", "👍");

    expect(resolveMatrixClientMock).toHaveBeenCalledOnce();
    const opts = resolveMatrixClientMock.mock.calls[0][0];
    expect(opts.accountId == null).toBe(true);
  });
});
