import { describe, expect, it } from "vitest";
import { toDiscordFileBlob } from "./send.shared.js";

describe("toDiscordFileBlob", () => {
  it("returns the same Blob when input is already a Blob", () => {
    const blob = new Blob(["hello"], { type: "image/png" });
    const result = toDiscordFileBlob(blob);
    expect(result).toBe(blob);
    expect(result.type).toBe("image/png");
  });

  it("converts Uint8Array to Blob with content-type preserved", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = toDiscordFileBlob(data, "image/png");
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("image/png");
    expect(result.size).toBe(4);
  });

  it("converts Uint8Array to Blob without content-type when omitted", () => {
    const data = new Uint8Array([0x00, 0x01]);
    const result = toDiscordFileBlob(data);
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("");
    expect(result.size).toBe(2);
  });

  it("preserves WebP content-type", () => {
    const data = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF header
    const result = toDiscordFileBlob(data, "image/webp");
    expect(result.type).toBe("image/webp");
  });

  it("preserves GIF content-type", () => {
    const data = new Uint8Array([0x47, 0x49, 0x46]); // GIF header
    const result = toDiscordFileBlob(data, "image/gif");
    expect(result.type).toBe("image/gif");
  });
});
