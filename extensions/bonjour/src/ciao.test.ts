// Bonjour tests cover ciao plugin behavior.
import { describe, expect, it } from "vitest";

const { classifyCiaoProcessError } = await import("./ciao.js");

describe("bonjour-ciao", () => {
  it("classifies ciao cancellation rejections separately from side effects", () => {
    expect(classifyCiaoProcessError(new Error("CIAO PROBING CANCELLED"))).toEqual({
      kind: "cancellation",
      formatted: "CIAO PROBING CANCELLED",
    });
  });

  it("classifies ciao interface assertions separately from side effects", () => {
    expect(
      classifyCiaoProcessError(
        new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted: "Reached illegal state! IPV4 address change from defined to undefined!",
    });
  });

  it("classifies ciao interface assertions using changed wording", () => {
    expect(
      classifyCiaoProcessError(
        new Error("Reached illegal state! IPv4 address changed from undefined to defined!"),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted: "Reached illegal state! IPv4 address changed from undefined to defined!",
    });
  });

  it("classifies ciao netmask assertions separately from side effects", () => {
    expect(
      classifyCiaoProcessError(
        Object.assign(
          new Error(
            "IP address version must match. Netmask cannot have a version different from the address!",
          ),
          { name: "AssertionError" },
        ),
      ),
    ).toEqual({
      kind: "netmask-assertion",
      formatted:
        "AssertionError: IP address version must match. Netmask cannot have a version different from the address!",
    });
  });

  it("classifies ciao self-probe races separately from side effects", () => {
    expect(
      classifyCiaoProcessError(
        new Error(
          "Can't probe for a service which is announced already. Received announcing for service OpenClaw Gateway._openclaw._tcp.local.",
        ),
      ),
    ).toEqual({
      kind: "self-probe",
      formatted:
        "Can't probe for a service which is announced already. Received announcing for service OpenClaw Gateway._openclaw._tcp.local.",
    });
  });

  it("suppresses ciao announcement cancellation rejections", () => {
    expect(classifyCiaoProcessError(new Error("Ciao announcement cancelled by shutdown"))).not.toBe(
      null,
    );
  });

  it("suppresses ciao probing cancellation rejections", () => {
    expect(classifyCiaoProcessError(new Error("CIAO PROBING CANCELLED"))).not.toBe(null);
  });

  it("suppresses wrapped ciao cancellation rejections", () => {
    expect(
      classifyCiaoProcessError({
        reason: new Error("CIAO ANNOUNCEMENT CANCELLED"),
      }),
    ).toEqual({
      kind: "cancellation",
      formatted: "CIAO ANNOUNCEMENT CANCELLED",
    });
  });

  it("suppresses aggregate ciao assertion rejections", () => {
    expect(
      classifyCiaoProcessError(
        new AggregateError([
          Object.assign(
            new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
            { name: "AssertionError" },
          ),
        ]),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted:
        "AssertionError: Reached illegal state! IPV4 address change from defined to undefined!",
    });
  });

  it("suppresses lower-case string cancellation reasons too", () => {
    expect(classifyCiaoProcessError("ciao announcement cancelled during cleanup")).not.toBe(null);
  });

  it("suppresses ciao interface assertion rejections as non-fatal", () => {
    const error = Object.assign(
      new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      { name: "AssertionError" },
    );

    expect(classifyCiaoProcessError(error)).not.toBe(null);
  });

  it("suppresses ciao netmask assertion errors as non-fatal", () => {
    const error = Object.assign(
      new Error(
        "IP address version must match. Netmask cannot have a version different from the address!",
      ),
      { name: "AssertionError" },
    );

    expect(classifyCiaoProcessError(error)).not.toBe(null);
  });

  it("classifies networkInterfaces SystemError failures (restricted sandboxes)", () => {
    const err = Object.assign(
      new Error("A system error occurred: uv_interface_addresses returned Unknown system error 1"),
      { name: "SystemError" },
    );
    expect(classifyCiaoProcessError(err)).toEqual({
      kind: "interface-enumeration-failure",
      formatted:
        "SystemError: A system error occurred: uv_interface_addresses returned Unknown system error 1",
    });
  });

  it("suppresses networkInterfaces failures wrapped in cause chains", () => {
    const inner = Object.assign(
      new Error("A system error occurred: uv_interface_addresses returned Unknown system error 1"),
      { name: "SystemError" },
    );
    const wrapper = new Error("ciao NetworkManager init failed", { cause: inner });
    expect(classifyCiaoProcessError(wrapper)).not.toBe(null);
  });

  it("keeps unrelated rejections visible", () => {
    expect(classifyCiaoProcessError(new Error("boom"))).toBe(null);
  });
});
