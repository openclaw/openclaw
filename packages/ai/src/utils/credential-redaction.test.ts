import { describe, expect, it, vi } from "vitest";
import {
  projectPreparedDiagnosticValue as projectPrepared,
  projectDiagnosticValue as project,
} from "./credential-redaction.js";

describe("diagnostic descriptor snapshots", () => {
  it("projects prepared producer records exactly like the descriptor walk", () => {
    const plain = {
      name: "apiKey",
      value: "secret-value",
      providerReplay: { kept: false },
      type: "input_image",
      data: "aGVsbG8=",
      items: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }, "text", 3],
      nested: { authorization: "Bearer abcdefghijklmnop", url: "data:image/png;base64,aGk=" },
    };
    for (const policy of [
      {},
      { redactCredentials: false, omitField: (key: string) => key === "providerReplay" },
    ]) {
      const expected = {
        name: "apiKey",
        value: policy.redactCredentials === false ? "secret-value" : "<redacted>",
        ...(policy.omitField ? {} : { providerReplay: { kept: false } }),
        type: "input_image",
        data: { redacted: "<redacted>", bytes: 5 },
        items: [{ mimeType: "image/png", bytes: { redacted: "<redacted>", bytes: 3 } }, "text", 3],
        nested: {
          ...(policy.redactCredentials === false
            ? { authorization: "Bearer abcdefghijklmnop" }
            : {}),
          url: "<redacted>",
        },
      };
      expect(projectPrepared(plain, policy)).toEqual(expected);
      expect(project(structuredClone(plain), policy)).toEqual(expected);
    }
  });

  it("keeps the descriptor fallback for prepared records with a changed prototype", () => {
    const getter = vi.fn(() => "must not be read");
    const value = { safe: "kept" };
    Object.setPrototypeOf(value, { inherited: "ignored" });
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    expect(projectPrepared(value)).toEqual({ safe: "kept" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not transfer producer trust into a reentrant public projection", () => {
    const getter = vi.fn(() => "must not be read");
    const foreign = Object.defineProperty({ safe: "kept" }, "secret", {
      enumerable: true,
      get: getter,
    });
    expect(
      projectPrepared(
        { outer: "kept" },
        {
          omitField: () => {
            expect(project(foreign)).toEqual({ safe: "kept" });
            return false;
          },
        },
      ),
    ).toEqual({ outer: "kept" });
    expect(getter).not.toHaveBeenCalled();
  });

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
