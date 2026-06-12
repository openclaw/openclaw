import { describe, expect, it } from "vitest";
import { isTelegramRichMethodUnavailableError } from "./rich-message.js";

describe("telegram rich-message classifier", () => {
  it("treats nested HttpError-style 404 status as rich-method unavailable", () => {
    const err = {
      message: "Network request for 'sendRichMessage' failed!",
      error: {
        status: 404,
        statusText: "Not Found",
      },
    };

    expect(isTelegramRichMethodUnavailableError(err)).toBe(true);
  });

  it("treats nested string 404 status on legacy/custom apiRoot responses as unavailable", () => {
    const err = {
      cause: {
        response: {
          status: "404",
          statusCode: "404",
        },
      },
    };

    expect(isTelegramRichMethodUnavailableError(err)).toBe(true);
  });

  it("does not classify unrelated transport failures as rich-method unavailable", () => {
    const err = {
      error: {
        status: 500,
        statusText: "Internal Server Error",
      },
    };

    expect(isTelegramRichMethodUnavailableError(err)).toBe(false);
  });
});
