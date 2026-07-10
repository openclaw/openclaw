import { describe, expect, it } from "vitest";
import { probeAgy } from "./probe.js";

describe("agy command probe", () => {
  it("accepts the required delegated-inference flags", () => {
    expect(
      probeAgy(() => ({
        status: 0,
        stdout: "--print --model --print-timeout",
        stderr: "",
      })),
    ).toEqual({
      ok: true,
      helpText: "--print --model --print-timeout",
    });
  });

  it("fails when agy cannot be executed", () => {
    expect(
      probeAgy(() => ({
        status: null,
        error: new Error("ENOENT"),
      })),
    ).toEqual({
      ok: false,
      reason: "Unable to execute agy --help: ENOENT",
    });
  });

  it("fails when the installed agy contract is incomplete", () => {
    expect(
      probeAgy(() => ({
        status: 0,
        stdout: "--print",
      })),
    ).toEqual({
      ok: false,
      reason: "agy --help is missing required flags: --model, --print-timeout",
    });
  });
});
