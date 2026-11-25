// Directory parser coverage uses mocked authentication and HTTP transport.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";

const { performMatrixRequestMock } = vi.hoisted(() => ({
  performMatrixRequestMock: vi.fn(),
}));

vi.mock("./matrix/sdk/transport.js", () => ({
  performMatrixRequest: performMatrixRequestMock,
}));

vi.mock("./matrix/client.js", () => ({
  resolveMatrixAuth: vi.fn(),
}));

function jsonArrayResponse(): { response: Response; text: string; buffer: Buffer } {
  const text = "[]";
  return {
    response: new Response(text, { status: 200, headers: { "content-type": "application/json" } }),
    text,
    buffer: Buffer.from(text, "utf8"),
  };
}

describe("matrix directory live (real client, mocked transport)", () => {
  const cfg = { channels: { matrix: {} } };

  beforeEach(() => {
    performMatrixRequestMock.mockReset();
    vi.mocked(resolveMatrixAuth).mockReset();
    vi.mocked(resolveMatrixAuth).mockResolvedValue({
      accountId: "assistant",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "test-token",
    });
  });

  it("rejects a real JSON array homeserver response for peer search instead of returning no matches", async () => {
    performMatrixRequestMock.mockResolvedValue(jsonArrayResponse());

    await expect(listMatrixDirectoryPeersLive({ cfg, query: "alice" })).rejects.toThrow(
      /non-object JSON response/,
    );
  });
});
