import { describe, expect, it, vi } from "vitest";
import { executeZalouserTool } from "./tool.js";

// Mock zca before any imports to ensure it's picked up correctly in ESM
vi.mock("./zca.js", () => ({
  runZca: vi.fn(async () => ({ ok: true, stdout: "{}", stderr: "" })),
  parseJsonOutput: vi.fn(() => ({})),
}));

describe("executeZalouserTool security", () => {
  it("rejects threadId starting with hyphen to prevent argument injection", async () => {
    const result = await executeZalouserTool("test-call", {
      action: "send",
      threadId: "--profile",
      message: "hello",
    });

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Invalid threadId");
    expect(text).toContain("cannot start with a hyphen");
  });

  it("allows message starting with hyphen (protected by -- separator)", async () => {
    const result = await executeZalouserTool("test-call", {
      action: "send",
      threadId: "123",
      message: "- hello",
    });

    expect(result.details).toEqual({ success: true, output: "{}" });
  });

  it("rejects query starting with hyphen", async () => {
    const result = await executeZalouserTool("test-call", {
      action: "friends",
      query: "-h",
    });

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Invalid query");
  });

  it("rejects url starting with hyphen", async () => {
    const result = await executeZalouserTool("test-call", {
      action: "image",
      threadId: "123",
      url: "--version",
    });

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Invalid url");
  });

  it("rejects profile starting with hyphen", async () => {
    const result = await executeZalouserTool("test-call", {
      action: "me",
      profile: "--help",
    });

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Invalid profile");
  });
});
