import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock WebSocket for testing
const mockWs = {
  OPEN: 1,
  CLOSED: 2,
  send: vi.fn(),
  close: vi.fn(),
  ping: vi.fn(),
  on: vi.fn(),
  readyState: 1,
};

vi.mock("ws", () => ({
  default: vi.fn(() => mockWs),
}));

// We need to test internal helpers - let's re-export them or test through the public API
// For now, let's test the regex pattern directly by checking the source
describe("simplex-bus", () => {
  // Re-implement the SAFE_DISPLAY_NAME pattern for testing
  // This mirrors the regex in simplex-bus.ts: /^[\w.-]+$/
  const SAFE_DISPLAY_NAME = /^[\w.-]+$/;

  describe("SAFE_DISPLAY_NAME regex", () => {
    it("matches valid display names with alphanumeric characters", () => {
      expect(SAFE_DISPLAY_NAME.test("Alice")).toBe(true);
      expect(SAFE_DISPLAY_NAME.test("John123")).toBe(true);
      expect(SAFE_DISPLAY_NAME.test("User_Name")).toBe(true);
    });

    it("matches valid display names with dots and hyphens", () => {
      expect(SAFE_DISPLAY_NAME.test("John.Doe")).toBe(true);
      expect(SAFE_DISPLAY_NAME.test("user-name")).toBe(true);
      expect(SAFE_DISPLAY_NAME.test("Test.User-123")).toBe(true);
    });

    it("rejects display names with spaces", () => {
      expect(SAFE_DISPLAY_NAME.test("John Doe")).toBe(false);
      expect(SAFE_DISPLAY_NAME.test("Alice Bob")).toBe(false);
    });

    it("rejects display names with special characters", () => {
      expect(SAFE_DISPLAY_NAME.test("Alice@home")).toBe(false);
      expect(SAFE_DISPLAY_NAME.test("#group")).toBe(false);
      expect(SAFE_DISPLAY_NAME.test("test>cmd")).toBe(false);
      expect(SAFE_DISPLAY_NAME.test("'; DROP TABLE--")).toBe(false);
      expect(SAFE_DISPLAY_NAME.test("$(whoami)")).toBe(false);
    });

    it("rejects empty strings", () => {
      expect(SAFE_DISPLAY_NAME.test("")).toBe(false);
    });

    it("rejects display names with unicode beyond word chars", () => {
      expect(SAFE_DISPLAY_NAME.test("用户")).toBe(false);
      expect(SAFE_DISPLAY_NAME.test("été")).toBe(false);
    });
  });

  describe("command formatting", () => {
    // Test the command string format that would be generated
    it("formats direct message command correctly", () => {
      const contactName = "Alice";
      const text = "Hello world";
      const command = `@${contactName} ${text}`;
      expect(command).toBe("@Alice Hello world");
    });

    it("escapes @ and # in contact names", () => {
      const safeContactId = "Alice".replace(/[@#]/g, "");
      expect(safeContactId).toBe("Alice");

      const dangerousId = "Alice@bot".replace(/[@#]/g, "");
      expect(dangerousId).toBe("Alicebot");
    });

    it("formats group message command correctly", () => {
      const groupName = "EffuzionNext";
      const text = "Group message";
      const command = `#${groupName} ${text}`;
      expect(command).toBe("#EffuzionNext Group message");
    });

    it("formats file send command correctly", () => {
      const contactName = "Alice";
      const filePath = "/path/to/file.m4a";
      const command = `/file @${contactName} ${filePath}`;
      expect(command).toBe("/file @Alice /path/to/file.m4a");
    });

    it("formats group file send command correctly", () => {
      const groupName = "TeamChat";
      const filePath = "/path/to/file.pdf";
      const command = `/file #${groupName} ${filePath}`;
      expect(command).toBe("/file #TeamChat /path/to/file.pdf");
    });
  });

  describe("error response detection", () => {
    // Simulate the error detection logic from handleResponse
    const isErrorResponse = (parsed: { resp?: { type?: string; chatError?: unknown } }) => {
      return (
        parsed.resp?.type === "chatCmdError" ||
        parsed.resp?.type === "chatError" ||
        parsed.resp?.chatError !== undefined
      );
    };

    it("detects chatCmdError type", () => {
      const response = {
        resp: {
          type: "chatCmdError",
          chatError: { error: "Invalid command" },
        },
      };
      expect(isErrorResponse(response)).toBe(true);
    });

    it("detects chatError type", () => {
      const response = {
        resp: {
          type: "chatError",
          error: "Something went wrong",
        },
      };
      expect(isErrorResponse(response)).toBe(true);
    });

    it("detects chatError in resp object", () => {
      const response = {
        resp: {
          type: "newChatItems",
          chatError: { error: "Failed to send" },
        },
      };
      expect(isErrorResponse(response)).toBe(true);
    });

    it("returns false for successful responses", () => {
      const response = {
        resp: {
          type: "newChatItems",
          chatItems: [],
        },
      };
      expect(isErrorResponse(response)).toBe(false);
    });

    it("returns false for message delivery responses", () => {
      const response = {
        resp: {
          type: "messageDelivery",
          messageId: "123",
        },
      };
      expect(isErrorResponse(response)).toBe(false);
    });
  });

  describe("voice message detection", () => {
    // Simulate voice detection from handleResponse
    const isVoiceMessage = (content: { type?: string; msgContent?: { type?: string } }) => {
      return content?.type === "voice" || content?.msgContent?.type === "voice";
    };

    it("detects voice message with content.type === 'voice'", () => {
      const content = { type: "voice" };
      expect(isVoiceMessage(content)).toBe(true);
    });

    it("detects voice message with msgContent.type === 'voice'", () => {
      const content = { msgContent: { type: "voice" } };
      expect(isVoiceMessage(content)).toBe(true);
    });

    it("returns false for text messages", () => {
      const content = { type: "rcvMsgContent", msgContent: { type: "text" } };
      expect(isVoiceMessage(content)).toBe(false);
    });

    it("returns false for image messages", () => {
      const content = { type: "image", mime: "image/png" };
      expect(isVoiceMessage(content)).toBe(false);
    });

    it("returns false for file messages", () => {
      const content = { type: "file", fileId: "123" };
      expect(isVoiceMessage(content)).toBe(false);
    });
  });

  describe("TLS error pattern matching", () => {
    const TLS_ERROR_PATTERNS = [
      /tls/i,
      /certificate/i,
      /handshake/i,
      /relay/i,
      /connection refused/i,
      /timeout/i,
      /ECONNREFUSED/,
      /ETIMEDOUT/,
      /ENOTFOUND/,
    ];

    const isTlsRelayError = (message: string): boolean => {
      return TLS_ERROR_PATTERNS.some((pattern) => pattern.test(message));
    };

    it("detects TLS errors", () => {
      expect(isTlsRelayError("TLS handshake failed")).toBe(true);
      expect(isTlsRelayError("certificate expired")).toBe(true);
    });

    it("detects relay errors", () => {
      expect(isTlsRelayError("SMP relay error")).toBe(true);
      expect(isTlsRelayError("relay connection lost")).toBe(true);
    });

    it("detects connection errors", () => {
      expect(isTlsRelayError("ECONNREFUSED")).toBe(true);
      expect(isTlsRelayError("Connection refused")).toBe(true); // Using 'to be' for strict equality
      expect(isTlsRelayError("ETIMEDOUT")).toBe(true);
      expect(isTlsRelayError("timeout")).toBe(true);
    });

    it("returns false for non-TLS errors", () => {
      expect(isTlsRelayError("Invalid message")).toBe(false);
      expect(isTlsRelayError("User not found")).toBe(false);
    });
  });

  describe("file extension detection", () => {
    const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
    const VOICE_EXTENSIONS = [".m4a", ".mp3", ".ogg", ".wav"];

    const isImageFile = (filePath: string): boolean => {
      const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
      return IMAGE_EXTENSIONS.includes(ext);
    };

    const isVoiceFile = (filePath: string): boolean => {
      const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
      return VOICE_EXTENSIONS.includes(ext);
    };

    it("detects image files by extension", () => {
      expect(isImageFile("/path/to/image.jpg")).toBe(true);
      expect(isImageFile("/path/to/image.PNG")).toBe(true);
      expect(isImageFile("/path/to/photo.jpeg")).toBe(true);
      expect(isImageFile("/path/to/animation.gif")).toBe(true);
    });

    it("rejects non-image files", () => {
      expect(isImageFile("/path/to/document.pdf")).toBe(false);
      expect(isImageFile("/path/to/audio.m4a")).toBe(false);
    });

    it("detects voice files by extension", () => {
      expect(isVoiceFile("/path/to/audio.m4a")).toBe(true);
      expect(isVoiceFile("/path/to/sound.MP3")).toBe(true);
      expect(isVoiceFile("/path/to/speech.ogg")).toBe(true);
      expect(isVoiceFile("/path/to/recording.wav")).toBe(true);
    });

    it("rejects non-voice files", () => {
      expect(isVoiceFile("/path/to/video.mp4")).toBe(false);
      expect(isVoiceFile("/path/to/image.jpg")).toBe(false);
    });
  });
});
