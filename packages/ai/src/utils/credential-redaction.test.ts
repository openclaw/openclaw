import { describe, expect, it, vi } from "vitest";
import { projectDiagnosticValue as project } from "./credential-redaction.js";

describe("diagnostic descriptor snapshots", () => {
  it("keeps media and credential classification isolated through reentrant policy callbacks", () => {
    const nested: unknown[] = [];
    const value = {
      outer: { mime_type: "image/png", DATA: "QUJDRA==", "api-key": "synthetic" },
      second: { Password: "synthetic", "safe-label": "kept" },
    };
    const projected = project(value, {
      omitField(key) {
        if (key === "outer") {
          nested.push(project({ "Access-Token": "synthetic", visible_key: "inner" }));
        }
        return false;
      },
      projectMedia(key, media) {
        nested.push(project({ input_image_url: "https://media.invalid", safe: "media" }));
        return { [key]: { redacted: true, bytes: media.bytes } };
      },
    });
    expect(projected).toEqual({
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

    expect(JSON.stringify(project(value))).toBe(
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
          target.later = "after traversal";
          return Reflect.ownKeys(child);
        },
      },
    );
    target.later = "before traversal";

    expect(project(target)).toEqual({ first: { detail: "safe" }, later: "before traversal" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("counts symbols toward the field cap before reading a late credential discriminator", () => {
    const descriptorKeys: PropertyKey[] = [];
    const value = new Proxy(
      {},
      {
        ownKeys: () => [...Array.from({ length: 63 }, () => Symbol("field")), "value", "name"],
        getOwnPropertyDescriptor(_target, key) {
          descriptorKeys.push(key);
          return {
            configurable: true,
            enumerable: true,
            value: key === "name" ? "password" : "synthetic",
          };
        },
      },
    );

    expect(project(value)).toEqual({ value: "<redacted>" });
    expect(descriptorKeys).toEqual(["value"]);
  });
});
