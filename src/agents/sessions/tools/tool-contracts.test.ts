import { describe, expectTypeOf, it } from "vitest";
import type { WriteToolInput } from "./tool-contracts.js";

describe("write tool exported contract", () => {
  it("represents append in the shared write tool input", () => {
    expectTypeOf<WriteToolInput>().toMatchTypeOf<{
      path: string;
      content: string;
      append?: boolean;
    }>();
  });
});
