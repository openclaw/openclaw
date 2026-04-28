import { describe, expect, it } from "vitest";
import { isCardTableLimitError, parseCardKitError } from "./card-error.js";

describe("card-error", () => {
  it("detects Card Kit table-limit errors from JSON error messages", () => {
    const err = new Error(
      'Feishu card send failed: {"code":230099,"data":{"ErrCode":11310,"ErrMsg":"card table number over limit"}}',
    );

    expect(parseCardKitError(err)).toEqual({
      code: 230099,
      errCode: 11310,
      msg: "card table number over limit",
    });
    expect(isCardTableLimitError(err)).toBe(true);
  });

  it("detects Card Kit table-limit errors from Axios response data before stringifying", () => {
    const err: { response: { data: unknown }; self?: unknown } = {
      response: {
        data: {
          code: 230099,
          data: {
            ErrCode: 11310,
            ErrMsg: "card table number over limit",
          },
        },
      },
    };
    err.self = err;

    expect(isCardTableLimitError(err)).toBe(true);
  });

  it("detects plain-string table-limit errors when structured codes were dropped", () => {
    expect(isCardTableLimitError("Feishu card send failed: card table number over limit")).toBe(
      true,
    );
  });

  it("does not classify unrelated 230099 card errors as table-limit errors", () => {
    expect(
      isCardTableLimitError({
        code: 230099,
        data: {
          ErrCode: 99999,
          ErrMsg: "some other card validation error",
        },
      }),
    ).toBe(false);
  });
});
