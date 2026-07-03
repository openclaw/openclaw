import { describe, it, expect } from "vitest";
// Import the typed error classes
import {
  CodexAppServerVersionError,
  CodexAppServerStartupTimeoutError,
  CodexAppServerStartupAbortedError,
} from "../extensions/codex/src/app-server/errors.js";

// Verify that instanceof-based classification works
// (the whole point of this fix: remove fragile Error.message string matching)

describe("Typed error classification (instanceof)", () => {
  it("CodexAppServerVersionError is distinguishable from a plain Error", () => {
    const typed = new CodexAppServerVersionError("version too old");
    const plain = new Error("version too old");

    // Both are Errors (backward-compatible)
    expect(typed).toBeInstanceOf(Error);
    expect(plain).toBeInstanceOf(Error);

    // Only the typed one is instanceof CodexAppServerVersionError
    expect(typed).toBeInstanceOf(CodexAppServerVersionError);
    expect(plain).not.toBeInstanceOf(CodexAppServerVersionError);
  });

  it("CodexAppServerStartupTimeoutError can be classified by instanceof", () => {
    const timeout = new CodexAppServerStartupTimeoutError();
    const plain = new Error("codex app-server startup timed out");

    expect(timeout).toBeInstanceOf(CodexAppServerStartupTimeoutError);
    expect(plain).not.toBeInstanceOf(CodexAppServerStartupTimeoutError);
    // Message content is preserved (backward-compatible)
    expect(timeout.message).toBe("codex app-server startup timed out");
  });

  it("CodexAppServerStartupAbortedError can be classified by instanceof", () => {
    const aborted = new CodexAppServerStartupAbortedError();
    const plain = new Error("codex app-server startup aborted");

    expect(aborted).toBeInstanceOf(CodexAppServerStartupAbortedError);
    expect(plain).not.toBeInstanceOf(CodexAppServerStartupAbortedError);
    expect(aborted.message).toBe("codex app-server startup aborted");
  });

  it("renaming a plain Error message does NOT trigger false instanceof match", () => {
    // This was the bug: rewording a message would silently break control flow
    const renamed = new Error("something timed out"); // could match endsWith('timed out')

    expect(renamed).not.toBeInstanceOf(CodexAppServerStartupTimeoutError);
    expect(renamed).not.toBeInstanceOf(CodexAppServerStartupAbortedError);
  });

  it("typed errors keep their .name property", () => {
    expect(new CodexAppServerVersionError("test").name).toBe("CodexAppServerVersionError");
    expect(new CodexAppServerStartupTimeoutError().name).toBe("CodexAppServerStartupTimeoutError");
    expect(new CodexAppServerStartupAbortedError().name).toBe("CodexAppServerStartupAbortedError");
  });
});

console.log("All runtime instanceof checks passed.");
