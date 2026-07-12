// Signal setup-core adapter tests cover buildPatch port validation.
import { describe, expect, test } from "vitest";
import { testing } from "./setup-core.js";

const { buildSignalSetupPatch } = testing;

describe("buildSignalSetupPatch httpPort", () => {
  test("accepts a valid port string", () => {
    const patch = buildSignalSetupPatch({ httpPort: "7580" });
    expect(patch.httpPort).toBe(7580);
  });

  test("accepts port 1 (minimum)", () => {
    const patch = buildSignalSetupPatch({ httpPort: "1" });
    expect(patch.httpPort).toBe(1);
  });

  test("accepts port 65535 (maximum)", () => {
    const patch = buildSignalSetupPatch({ httpPort: "65535" });
    expect(patch.httpPort).toBe(65535);
  });

  test("rejects NaN-producing string", () => {
    const patch = buildSignalSetupPatch({ httpPort: "abc" });
    expect(patch).not.toHaveProperty("httpPort");
  });

  test("rejects empty string", () => {
    const patch = buildSignalSetupPatch({ httpPort: "" });
    expect(patch).not.toHaveProperty("httpPort");
  });

  test("rejects port 0", () => {
    const patch = buildSignalSetupPatch({ httpPort: "0" });
    expect(patch).not.toHaveProperty("httpPort");
  });

  test("rejects port beyond 65535", () => {
    const patch = buildSignalSetupPatch({ httpPort: "70000" });
    expect(patch).not.toHaveProperty("httpPort");
  });

  test("rejects float string", () => {
    const patch = buildSignalSetupPatch({ httpPort: "7580.5" });
    expect(patch).not.toHaveProperty("httpPort");
  });

  test("omits httpPort when input is undefined", () => {
    const patch = buildSignalSetupPatch({});
    expect(patch).not.toHaveProperty("httpPort");
  });

  test("preserves other fields when httpPort is valid", () => {
    const patch = buildSignalSetupPatch({
      signalNumber: "+15555550123",
      cliPath: "/usr/bin/signal-cli",
      httpPort: "8080",
    });
    expect(patch.account).toBe("+15555550123");
    expect(patch.cliPath).toBe("/usr/bin/signal-cli");
    expect(patch.httpPort).toBe(8080);
  });

  test("preserves other fields when httpPort is invalid", () => {
    const patch = buildSignalSetupPatch({
      signalNumber: "+15555550123",
      httpPort: "invalid",
    });
    expect(patch.account).toBe("+15555550123");
    expect(patch).not.toHaveProperty("httpPort");
  });
});
