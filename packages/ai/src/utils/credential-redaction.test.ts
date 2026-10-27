import { expect, it, vi } from "vitest";
import {
  projectPreparedDiagnosticValue as projectPrepared,
  projectDiagnosticValue as project,
  redactDiagnosticText,
} from "./credential-redaction.js";

it("redacts parsed diagnostic JSON without probing its records as foreign objects", () => {
  const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
  const headers = vi.spyOn(Headers.prototype, "has");
  descriptors.mockClear();
  let projected: string;
  let descriptorReads: number;
  let headerProbes: number;
  try {
    projected = redactDiagnosticText(
      'payload {"error":{"code":"overloaded","details":[{"safe":"kept"}]},"type":"video","data":"QUJDRA=="}',
    );
    descriptorReads = descriptors.mock.calls.length;
    headerProbes = headers.mock.calls.length;
  } finally {
    descriptors.mockRestore();
    headers.mockRestore();
  }
  expect(projected).toBe(
    'payload {"data":{"bytes":4,"redacted":"<redacted>"},"error":{"code":"overloaded","details":[{"safe":"kept"}]},"type":"video"}',
  );
  expect(descriptorReads).toBe(0);
  expect(headerProbes).toBe(0);
});

it("projects prepared producer records exactly like the descriptor walk", () => {
  const plain = {
    name: "apiKey",
    value: "secret-value",
    providerReplay: { kept: false },
    type: "input_image",
    data: "aGVsbG8=",
    items: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }, "text", 3],
    authorization: "Bearer abcdefghijklmnop",
    url: "data:image/png;base64,aGk=",
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
      ...(policy.redactCredentials === false ? { authorization: "Bearer abcdefghijklmnop" } : {}),
      url: "<redacted>",
    };
    expect(projectPrepared(plain, policy)).toEqual(expected);
    expect(project(structuredClone(plain), policy)).toEqual(expected);
  }
});

it("keeps changed prototypes and reentrant public projections getter-safe", () => {
  const getter = vi.fn(() => "must not be read");
  const value = Object.defineProperty({ safe: "kept" }, "secret", {
    enumerable: true,
    get: getter,
  });
  Object.setPrototypeOf(value, { inherited: "ignored" });
  expect(projectPrepared(value)).toEqual({ safe: "kept" });
  Object.setPrototypeOf(value, Object.prototype);
  const omitField = () => {
    expect(project(value)).toEqual({ safe: "kept" });
    return false;
  };
  expect(projectPrepared({ outer: "kept" }, { omitField })).toEqual({ outer: "kept" });
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

it("snapshots siblings before visiting shared children in numeric key order", () => {
  const target: Record<string, unknown> = {};
  const shared = new Proxy(
    { detail: "safe" },
    {
      ownKeys(child) {
        target.later = "after traversal";
        return Reflect.ownKeys(child);
      },
    },
  );
  Object.assign(target, {
    tail: shared,
    2: shared,
    1: shared,
    "01": shared,
    later: "before traversal",
  });
  const value = new Proxy(target, { ownKeys: () => ["tail", "2", "1", "01", "later"] });
  expect(JSON.stringify(project(value))).toBe(
    '{"1":{"detail":"safe"},"2":"[Circular]","tail":"[Circular]","01":"[Circular]","later":"before traversal"}',
  );
});

it("counts symbols toward the field cap before reading a late credential discriminator", () => {
  const descriptorKeys: PropertyKey[] = [];
  const fields = { name: "password", value: "synthetic" };
  const value = new Proxy(
    {},
    {
      ownKeys: () => [...Array.from({ length: 63 }, () => Symbol("field")), "value", "name"],
      getOwnPropertyDescriptor(_target, key) {
        descriptorKeys.push(key);
        return { configurable: true, enumerable: true, value: Reflect.get(fields, key) };
      },
    },
  );

  expect(project(value)).toEqual({ value: "<redacted>" });
  expect(descriptorKeys).toEqual(["value"]);
});
