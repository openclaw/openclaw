import { describe, expect, test } from "vitest";
import { formatRecalledMemoryForModel } from "./memory-policy.js";

describe("memory recall text", () => {
  test("formatRecalledMemoryForModel preserves intentional multi-space formatting when no media annotation is present", () => {
    const tabular = "Col A  Col B  Col C";
    expect(formatRecalledMemoryForModel(tabular)).toBe("Col A  Col B  Col C");

    const indented = "function foo() {\n  return 42;\n}";
    expect(formatRecalledMemoryForModel(indented)).toBe("function foo() {\n  return 42;\n}");
  });

  test("formatRecalledMemoryForModel leaves legacy media text inert and preserves formatting", () => {
    const input = [
      "Line one of the memory",
      "Line two with [media attached: /tmp/p.jpg (image/jpeg)] inline",
      "Line three of the memory",
    ].join("\n");
    const result = formatRecalledMemoryForModel(input);
    expect(result).toBe(input);
  });

  test("formatRecalledMemoryForModel preserves inert media text while escaping markup", () => {
    expect(
      formatRecalledMemoryForModel(
        "User sent <image> [media attached: /Users/alex/.openclaw/media/photo.jpg (image/jpeg)] & said hello",
      ),
    ).toBe(
      "User sent &lt;image&gt; [media attached: /Users/alex/.openclaw/media/photo.jpg (image/jpeg)] &amp; said hello",
    );

    expect(
      formatRecalledMemoryForModel(
        "Sent [media attached 1/2: /cache/img1.png (image/png)] and [media attached 2/2: /cache/img2.png (image/png)]",
      ),
    ).toBe(
      "Sent [media attached 1/2: /cache/img1.png (image/png)] and [media attached 2/2: /cache/img2.png (image/png)]",
    );

    expect(
      formatRecalledMemoryForModel(
        "Photo [media attached: media://inbound/abc123.jpg] was attached",
      ),
    ).toBe("Photo [media attached: media://inbound/abc123.jpg] was attached");
  });
});
