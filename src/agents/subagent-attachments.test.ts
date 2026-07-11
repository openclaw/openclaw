// Regression tests for attachment-name validation, focused on C1 control
// rejection and on not leaking raw control bytes back into the diagnostic.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAcpSessionsSpawnImageAttachments } from "./subagent-attachments.js";

const CONFIG = {
  tools: { sessions_spawn: { attachments: { enabled: true } } },
} as unknown as OpenClawConfig;

// base64 for "hello" (5 bytes), well under the default per-file limit.
const HELLO_B64 = "aGVsbG8=";

function errorOf(result: ReturnType<typeof resolveAcpSessionsSpawnImageAttachments>): string {
  return result && result.status === "error" ? result.error : "";
}

describe("resolveAcpSessionsSpawnImageAttachments name validation", () => {
  it("rejects a C1-bearing name and escapes it in the diagnostic", () => {
    // U+009B is the C1 CSI introducer (alternative ANSI escape prefix, ESC [).
    const CSI = String.fromCharCode(0x9b);
    const result = resolveAcpSessionsSpawnImageAttachments({
      config: CONFIG,
      attachments: [
        {
          name: `bad${CSI}name.png`,
          content: HELLO_B64,
          encoding: "base64",
          mimeType: "image/png",
        },
      ],
    });

    expect(result?.status).toBe("error");
    const error = errorOf(result);
    expect(error).toContain("attachments_invalid_name");
    // The rejected name is echoed with the C1 byte escaped, not raw.
    expect(error).toContain("\\x9b");
    expect(error).not.toContain(CSI);
  });

  it("rejects every byte across the full C1 range 0x80-0x9f", () => {
    for (let code = 0x80; code <= 0x9f; code += 1) {
      const result = resolveAcpSessionsSpawnImageAttachments({
        config: CONFIG,
        attachments: [
          {
            name: `n${String.fromCharCode(code)}m.png`,
            content: HELLO_B64,
            encoding: "base64",
            mimeType: "image/png",
          },
        ],
      });
      expect(result?.status).toBe("error");
      expect(errorOf(result)).toContain("attachments_invalid_name");
      // No raw C1 byte survives into the returned diagnostic.
      expect(errorOf(result)).not.toContain(String.fromCharCode(code));
    }
  });

  it("accepts an ordinary image attachment name", () => {
    const result = resolveAcpSessionsSpawnImageAttachments({
      config: CONFIG,
      attachments: [
        {
          name: "photo.png",
          content: HELLO_B64,
          encoding: "base64",
          mimeType: "image/png",
        },
      ],
    });
    expect(result?.status).toBe("ok");
  });
});
