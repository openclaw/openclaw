// Bonjour tests cover ciao plugin behavior.
import { describe, expect, it } from "vitest";

<<<<<<< HEAD
const { classifyCiaoProcessError } = await import("./ciao.js");

describe("bonjour-ciao", () => {
  it("classifies ciao cancellation rejections separately from side effects", () => {
    expect(classifyCiaoProcessError(new Error("CIAO PROBING CANCELLED"))).toEqual({
=======
const { classifyCiaoUnhandledRejection, ignoreCiaoUnhandledRejection } = await import("./ciao.js");

describe("bonjour-ciao", () => {
  it("classifies ciao cancellation rejections separately from side effects", () => {
    expect(classifyCiaoUnhandledRejection(new Error("CIAO PROBING CANCELLED"))).toEqual({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      kind: "cancellation",
      formatted: "CIAO PROBING CANCELLED",
    });
  });

  it("classifies ciao interface assertions separately from side effects", () => {
    expect(
<<<<<<< HEAD
      classifyCiaoProcessError(
=======
      classifyCiaoUnhandledRejection(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted: "Reached illegal state! IPV4 address change from defined to undefined!",
    });
  });

  it("classifies ciao interface assertions using changed wording", () => {
    expect(
<<<<<<< HEAD
      classifyCiaoProcessError(
=======
      classifyCiaoUnhandledRejection(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        new Error("Reached illegal state! IPv4 address changed from undefined to defined!"),
      ),
    ).toEqual({
      kind: "interface-assertion",
      formatted: "Reached illegal state! IPv4 address changed from undefined to defined!",
    });
  });

  it("classifies ciao netmask assertions separately from side effects", () => {
    expect(
<<<<<<< HEAD
      classifyCiaoProcessError(
=======
      classifyCiaoUnhandledRejection(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
      classifyCiaoProcessError(
=======
      classifyCiaoUnhandledRejection(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
    expect(classifyCiaoProcessError(new Error("Ciao announcement cancelled by shutdown"))).not.toBe(
      null,
=======
    expect(ignoreCiaoUnhandledRejection(new Error("Ciao announcement cancelled by shutdown"))).toBe(
      true,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    );
  });

  it("suppresses ciao probing cancellation rejections", () => {
<<<<<<< HEAD
    expect(classifyCiaoProcessError(new Error("CIAO PROBING CANCELLED"))).not.toBe(null);
=======
    expect(ignoreCiaoUnhandledRejection(new Error("CIAO PROBING CANCELLED"))).toBe(true);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("suppresses wrapped ciao cancellation rejections", () => {
    expect(
<<<<<<< HEAD
      classifyCiaoProcessError({
=======
      classifyCiaoUnhandledRejection({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        reason: new Error("CIAO ANNOUNCEMENT CANCELLED"),
      }),
    ).toEqual({
      kind: "cancellation",
      formatted: "CIAO ANNOUNCEMENT CANCELLED",
    });
  });

  it("suppresses aggregate ciao assertion rejections", () => {
    expect(
<<<<<<< HEAD
      classifyCiaoProcessError(
=======
      classifyCiaoUnhandledRejection(
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
    expect(classifyCiaoProcessError("ciao announcement cancelled during cleanup")).not.toBe(null);
=======
    expect(ignoreCiaoUnhandledRejection("ciao announcement cancelled during cleanup")).toBe(true);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("suppresses ciao interface assertion rejections as non-fatal", () => {
    const error = Object.assign(
      new Error("Reached illegal state! IPV4 address change from defined to undefined!"),
      { name: "AssertionError" },
    );

<<<<<<< HEAD
    expect(classifyCiaoProcessError(error)).not.toBe(null);
=======
    expect(ignoreCiaoUnhandledRejection(error)).toBe(true);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("suppresses ciao netmask assertion errors as non-fatal", () => {
    const error = Object.assign(
      new Error(
        "IP address version must match. Netmask cannot have a version different from the address!",
      ),
      { name: "AssertionError" },
    );

<<<<<<< HEAD
    expect(classifyCiaoProcessError(error)).not.toBe(null);
=======
    expect(ignoreCiaoUnhandledRejection(error)).toBe(true);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("classifies networkInterfaces SystemError failures (restricted sandboxes)", () => {
    const err = Object.assign(
      new Error("A system error occurred: uv_interface_addresses returned Unknown system error 1"),
      { name: "SystemError" },
    );
<<<<<<< HEAD
    expect(classifyCiaoProcessError(err)).toEqual({
=======
    expect(classifyCiaoUnhandledRejection(err)).toEqual({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
    expect(classifyCiaoProcessError(wrapper)).not.toBe(null);
  });

  it("keeps unrelated rejections visible", () => {
    expect(classifyCiaoProcessError(new Error("boom"))).toBe(null);
=======
    expect(ignoreCiaoUnhandledRejection(wrapper)).toBe(true);
  });

  it("keeps unrelated rejections visible", () => {
    expect(ignoreCiaoUnhandledRejection(new Error("boom"))).toBe(false);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
});
