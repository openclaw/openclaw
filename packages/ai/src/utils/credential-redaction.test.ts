import { describe, expect, it, vi } from "vitest";
import { projectDiagnosticValue } from "./credential-redaction.js";

describe("diagnostic descriptor snapshots", () => {
  it("keeps media and credential classification isolated through reentrant policy callbacks", () => {
    const nested: unknown[] = [];
    expect(
      projectDiagnosticValue(
        {
          outer: { mime_type: "image/png", DATA: "QUJDRA==", "api-key": "synthetic-private" },
          second: { Password: "synthetic-private", "safe-label": "kept" },
        },
        {
          omitField(key) {
            if (key === "outer") {
              nested.push(
                projectDiagnosticValue({
                  "Access-Token": "synthetic-private",
                  visible_key: "inner",
                }),
              );
            }
            return false;
          },
          projectMedia(key, media) {
            nested.push(
              projectDiagnosticValue({
                input_image_url: "https://media.invalid/private",
                safe: "media",
              }),
            );
            return { [key]: { redacted: true, bytes: media.bytes } };
          },
        },
      ),
    ).toEqual({
      outer: { mime_type: "image/png", DATA: { redacted: true, bytes: 4 } },
      second: { "safe-label": "kept" },
    });
    expect(nested).toEqual([
      { visible_key: "inner" },
      { input_image_url: "<redacted>", safe: "media" },
    ]);
  });

  it("visits numeric keys before other proxy keys when bounding shared references", () => {
    const shared = { detail: "safe" };
    const value = new Proxy(
      { tail: shared, 2: shared, 1: shared, "01": shared },
      { ownKeys: () => ["tail", "2", "1", "01"] },
    );

    expect(JSON.stringify(projectDiagnosticValue(value))).toBe(
      '{"1":{"detail":"safe"},"2":"[Circular]","tail":"[Circular]","01":"[Circular]"}',
    );
  });

  it("captures sibling descriptors before visiting children without invoking getters", () => {
    const getter = vi.fn(() => "must not be read");
    const target: Record<string, unknown> = {};
    target.first = new Proxy(
      Object.defineProperty({ detail: "safe" }, "hostile", { enumerable: true, get: getter }),
      {
        ownKeys(child) {
          target.later = "changed during child traversal";
          return Reflect.ownKeys(child);
        },
      },
    );
    target.later = "captured before child traversal";

    expect(projectDiagnosticValue(target)).toEqual({
      first: { detail: "safe" },
      later: "captured before child traversal",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("counts symbols toward the field cap before reading a late credential discriminator", () => {
    const descriptorKeys: PropertyKey[] = [];
    const keys = [...Array.from({ length: 63 }, () => Symbol("field")), "value", "name"];
    const value = new Proxy(
      {},
      {
        ownKeys: () => keys,
        getOwnPropertyDescriptor(_target, key) {
          descriptorKeys.push(key);
          return {
            configurable: true,
            enumerable: true,
            value: key === "name" ? "password" : "synthetic-private-value",
          };
        },
      },
    );

    expect(projectDiagnosticValue(value)).toEqual({ value: "<redacted>" });
    expect(descriptorKeys).toEqual(["value"]);
  });
});
