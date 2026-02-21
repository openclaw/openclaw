import { describe, expect, test } from "vitest";
import { resolveCaptureContent } from "./otel-utils.js";

describe("resolveCaptureContent", () => {
  test("enables all fields when captureContent is true", () => {
    expect(resolveCaptureContent(true)).toEqual({
      inputMessages: true,
      outputMessages: true,
      systemInstructions: true,
      toolDefinitions: true,
      toolContent: true,
    });
  });

  test("disables all fields when captureContent is false or undefined", () => {
    expect(resolveCaptureContent(false)).toEqual({
      inputMessages: false,
      outputMessages: false,
      systemInstructions: false,
      toolDefinitions: false,
      toolContent: false,
    });
    expect(resolveCaptureContent(undefined)).toEqual({
      inputMessages: false,
      outputMessages: false,
      systemInstructions: false,
      toolDefinitions: false,
      toolContent: false,
    });
  });

  test("uses strict opt-in in object mode", () => {
    expect(resolveCaptureContent({})).toEqual({
      inputMessages: false,
      outputMessages: false,
      systemInstructions: false,
      toolDefinitions: false,
      toolContent: false,
    });
    expect(resolveCaptureContent({ inputMessages: true })).toEqual({
      inputMessages: true,
      outputMessages: false,
      systemInstructions: false,
      toolDefinitions: false,
      toolContent: false,
    });
    expect(resolveCaptureContent({ inputMessages: undefined })).toEqual({
      inputMessages: false,
      outputMessages: false,
      systemInstructions: false,
      toolDefinitions: false,
      toolContent: false,
    });
  });
});
