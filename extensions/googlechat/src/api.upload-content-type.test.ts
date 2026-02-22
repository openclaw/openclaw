import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadGoogleChatAttachment } from "./api.js";
import { getGoogleChatAccessToken } from "./auth.js";

// Mock dependencies
vi.mock("./auth.js");
vi.mock("node:crypto", () => ({
  default: {
    randomUUID: () => "mock-uuid",
  },
}));

// Mock fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

const mockAccount = {
  accountId: "test",
  name: "Test",
  credentialSource: "json" as const,
  config: {},
  json: { client_email: "test@example.com", private_key: "key" },
};

describe("uploadGoogleChatAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoogleChatAccessToken).mockResolvedValue("mock-token");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ attachmentDataRef: { attachmentUploadToken: "token123" } }),
    });
  });

  it("uses provided contentType if present", async () => {
    await uploadGoogleChatAttachment({
      account: mockAccount,
      space: "spaces/AAA",
      filename: "test.png",
      buffer: Buffer.from("data"),
      contentType: "image/custom-png",
    });

    const call = fetchMock.mock.calls[0];
    const body = call[1].body as Buffer;
    const bodyStr = body.toString();
    
    expect(bodyStr).toContain("Content-Type: image/custom-png");
  });

  it("infers contentType from filename extension if missing", async () => {
    await uploadGoogleChatAttachment({
      account: mockAccount,
      space: "spaces/AAA",
      filename: "photo.jpg",
      buffer: Buffer.from("data"),
      // No contentType
    });

    const call = fetchMock.mock.calls[0];
    const body = call[1].body as Buffer;
    const bodyStr = body.toString();
    
    expect(bodyStr).toContain("Content-Type: image/jpeg");
  });

  it("infers contentType from filename extension (png)", async () => {
    await uploadGoogleChatAttachment({
      account: mockAccount,
      space: "spaces/AAA",
      filename: "image.png",
      buffer: Buffer.from("data"),
    });

    const call = fetchMock.mock.calls[0];
    const body = call[1].body as Buffer;
    const bodyStr = body.toString();
    
    expect(bodyStr).toContain("Content-Type: image/png");
  });

  it("defaults to application/octet-stream if unknown extension", async () => {
    await uploadGoogleChatAttachment({
      account: mockAccount,
      space: "spaces/AAA",
      filename: "unknown.xyz",
      buffer: Buffer.from("data"),
    });

    const call = fetchMock.mock.calls[0];
    const body = call[1].body as Buffer;
    const bodyStr = body.toString();
    
    expect(bodyStr).toContain("Content-Type: application/octet-stream");
  });
});
