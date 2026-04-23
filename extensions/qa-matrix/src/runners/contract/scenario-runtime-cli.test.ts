import { describe, expect, it } from "vitest";
import { formatMatrixQaCliCommand, redactMatrixQaCliOutput } from "./scenario-runtime-cli.js";

describe("Matrix QA CLI runtime", () => {
  it("redacts secret CLI arguments in diagnostic command text", () => {
    expect(
      formatMatrixQaCliCommand([
        "matrix",
        "verify",
        "backup",
        "restore",
        "--recovery-key",
        "abcdef1234567890ghij",
      ]),
    ).toBe("openclaw matrix verify backup restore --recovery-key [REDACTED]");
    expect(formatMatrixQaCliCommand(["matrix", "account", "add", "--access-token=token-123"])).toBe(
      "openclaw matrix account add --access-token=[REDACTED]",
    );
  });

  it("redacts Matrix token output before diagnostics and artifacts", () => {
    expect(
      redactMatrixQaCliOutput("GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij"),
    ).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });
});
