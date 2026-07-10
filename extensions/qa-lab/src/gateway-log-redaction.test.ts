import { describe, expect, it } from "vitest";
import { formatQaGatewayLogsForError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";

describe("gateway log redaction", () => {
  it("neutralizes GitHub workflow commands at every line boundary", () => {
    const raw = [
      "::set-output name=output_dir::/tmp/attacker",
      "safe",
      "\r::stop-commands::attacker-token",
      " \t::error::whitespace-prefixed",
      "prefix ##[error]legacy command",
    ].join("\n");

    expect(redactQaGatewayDebugText(raw)).toBe(
      [
        ": :set-output name=output_dir::/tmp/attacker",
        "safe",
        "\r: :stop-commands::attacker-token",
        " \t: :error::whitespace-prefixed",
        "prefix # #[error]legacy command",
      ].join("\n"),
    );
    expect(formatQaGatewayLogsForError(raw)).not.toContain("\n::");
    expect(formatQaGatewayLogsForError(raw)).not.toContain("##[");
  });
});
