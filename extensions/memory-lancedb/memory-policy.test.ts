import { expect, test } from "vitest";
import { formatRecalledMemoryForModel } from "./memory-policy.js";

test("recall escapes markup while preserving whitespace and inert legacy media text", () => {
  expect(
    formatRecalledMemoryForModel(
      "Col A  Col B\n  <image> [media attached: /tmp/p.jpg (image/jpeg)] & hello",
    ),
  ).toBe("Col A  Col B\n  &lt;image&gt; [media attached: /tmp/p.jpg (image/jpeg)] &amp; hello");
});
