import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_MICROVM_PREFIX } from "./constants.js";
import { detectBackend } from "./manage.js";

describe("detectBackend", () => {
  it("returns backend from registry entry when present", () => {
    expect(detectBackend("custom-prefix-foo", { backend: "microvm" })).toBe("microvm");
    expect(detectBackend("openclaw-vm-foo", { backend: "container" })).toBe("container");
  });

  it("falls back to prefix heuristic when registry has no backend", () => {
    expect(detectBackend(`${DEFAULT_SANDBOX_MICROVM_PREFIX}test`)).toBe("microvm");
    expect(detectBackend("openclaw-sbx-test")).toBe("container");
  });

  it("falls back to prefix heuristic when registry entry is undefined", () => {
    expect(detectBackend(`${DEFAULT_SANDBOX_MICROVM_PREFIX}session-1`, undefined)).toBe("microvm");
    expect(detectBackend("openclaw-sbx-session-1", undefined)).toBe("container");
  });

  it("falls back to prefix heuristic when backend field is undefined", () => {
    expect(detectBackend(`${DEFAULT_SANDBOX_MICROVM_PREFIX}test`, {})).toBe("microvm");
    expect(detectBackend("openclaw-sbx-test", {})).toBe("container");
  });
});
