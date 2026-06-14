import { describe, expectTypeOf, it } from "vitest";
import type { WriteToolCallEvent } from "./types.js";

describe("extension tool-call event contracts", () => {
  it("carries append through write tool-call events", () => {
    expectTypeOf<WriteToolCallEvent["input"]>().toMatchTypeOf<{
      path: string;
      content: string;
      append?: boolean;
    }>();
  });
});
