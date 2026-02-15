import { describe, expect, it } from "vitest";
import { isBillingErrorMessage, isAuthErrorMessage, sanitizeUserFacingText } from "./errors.js";

describe("isBillingErrorMessage — false positive regression (#16237)", () => {
  it("does not match calorie counts containing 402", () => {
    expect(isBillingErrorMessage("You've consumed 402 / 1,800 kcal today.")).toBe(false);
  });

  it("does not match addresses containing 402", () => {
    expect(isBillingErrorMessage("The office is at 402 Main Street, Suite 200.")).toBe(false);
  });

  it("does not match section/room references", () => {
    expect(isBillingErrorMessage("See Section 402 of the tax code")).toBe(false);
    expect(isBillingErrorMessage("Room 402 is on the fourth floor")).toBe(false);
  });

  it("does not match arbitrary numbers near 402", () => {
    expect(isBillingErrorMessage("We processed 402 requests today")).toBe(false);
    expect(isBillingErrorMessage("The file is 402 bytes")).toBe(false);
    expect(isBillingErrorMessage("Temperature reached 402°F")).toBe(false);
  });

  it("detects real billing errors with contextual 402", () => {
    expect(isBillingErrorMessage("HTTP 402 Payment Required")).toBe(true);
    expect(isBillingErrorMessage("http 402")).toBe(true);
    expect(isBillingErrorMessage('{"status": 402}')).toBe(true);
    expect(isBillingErrorMessage("error code=402")).toBe(true);
    expect(isBillingErrorMessage("got a 402 from the API")).toBe(true);
    expect(isBillingErrorMessage("returned 402")).toBe(true);
    expect(isBillingErrorMessage("402 payment required")).toBe(true);
  });

  it("detects billing errors by keyword", () => {
    expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    expect(isBillingErrorMessage("payment required")).toBe(true);
    expect(isBillingErrorMessage("credit balance is zero")).toBe(true);
    expect(isBillingErrorMessage("insufficient balance")).toBe(true);
  });
});

describe("isAuthErrorMessage — false positive regression", () => {
  it("does not match 401k retirement references", () => {
    expect(isAuthErrorMessage("Max out your 401k contributions this year")).toBe(false);
    expect(isAuthErrorMessage("The 401k plan has a 6% match")).toBe(false);
  });

  it("does not match 403 in normal numeric context", () => {
    expect(isAuthErrorMessage("There are 403 items in the database")).toBe(false);
    expect(isAuthErrorMessage("Page 403 of the manual")).toBe(false);
  });

  it("detects real auth errors", () => {
    expect(isAuthErrorMessage("HTTP 401 Unauthorized")).toBe(true);
    expect(isAuthErrorMessage("invalid api key")).toBe(true);
    expect(isAuthErrorMessage("403 Forbidden")).toBe(true);
    expect(isAuthErrorMessage("401 Unauthorized")).toBe(true);
  });
});

describe("sanitizeUserFacingText — billing false positive regression (#16237)", () => {
  it("does not rewrite normal text containing 402", () => {
    const text = "You've consumed 402 / 1,800 kcal today.";
    expect(sanitizeUserFacingText(text)).toBe(text);
    expect(sanitizeUserFacingText(text, { errorContext: true })).toBe(text);
  });
});
