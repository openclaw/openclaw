import { describe, expect, it } from "vitest";

const { classifyCiaoProcessError } = await import("./ciao.js");

describe("bonjour-ciao", () => {
  it("suppresses networkInterfaces failures wrapped in cause chains", () => {
    const inner = Object.assign(
      new Error("A system error occurred: uv_interface_addresses returned Unknown system error 1"),
      { name: "SystemError" },
    );
    const wrapper = new Error("ciao NetworkManager init failed", { cause: inner });
    expect(classifyCiaoProcessError(wrapper)).toEqual({
      kind: "interface-enumeration-failure",
      formatted:
        "SystemError: A system error occurred: uv_interface_addresses returned Unknown system error 1",
    });
  });

  it("keeps unrelated rejections visible", () => {
    expect(classifyCiaoProcessError(new Error("boom"))).toBe(null);
  });
});
