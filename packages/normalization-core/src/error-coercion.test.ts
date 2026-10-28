import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  coerceErrorMessage,
  collectNestedErrorCandidates,
  formatErrorMessage,
  formatErrorStackWithMessage,
  mapErrorCauseChain,
  ProviderAuthPersistenceError,
  stringifyNonErrorCause,
  toErrorObject,
  toStructuredErrorObject,
  toStringifiedError,
} from "./error-coercion.js";

const format = formatErrorMessage;
const throwRead = (): never => {
  throw new Error("unexpected field read");
};
const withGetter = <T extends object>(value: T, key: PropertyKey, get: () => unknown = throwRead) =>
  Object.defineProperty(value, key, { enumerable: true, get });
const withCause = (message: string, cause: unknown) => new Error(message, { cause });
const redactSecrets = (text: string) => text.replaceAll("secret", "[REDACTED]");

it("maps only the root and eight ordered causes, including repeated cyclic frames", () => {
  let error = new Error("beyond limit");
  for (let index = 8; index >= 0; index -= 1) {
    error = new Error(String(index), { cause: error });
  }
  expect(mapErrorCauseChain(error, (entry) => entry.message)).toEqual(
    Array.from({ length: 9 }, (_, index) => String(index)),
  );
  const cycle = new Error("loop");
  cycle.cause = cycle;
  expect(mapErrorCauseChain(cycle, (entry) => entry.message)).toEqual(Array(9).fill("loop"));
});

describe("formatErrorMessage", () => {
  it("keeps provider persistence diagnostics in initiating order without reordering other errors", () => {
    const persistence = withCause("write secret", new Error("write root"));
    const cleanup = new AggregateError([new Error("cleanup root")], "cleanup secret");
    const failure = new ProviderAuthPersistenceError("persistence failed", persistence, {
      cause: cleanup,
    });
    expect(formatErrorMessage(withCause("outer", failure), { redact: redactSecrets })).toBe(
      "outer | persistence failed | write [REDACTED] | cleanup [REDACTED] | write root | cleanup root",
    );
    const plain = new AggregateError([persistence, cleanup], "persistence failed", {
      cause: cleanup,
    });
    plain.name = "ProviderAuthPersistenceError";
    expect(formatErrorMessage(withCause("outer", plain), { redact: redactSecrets })).toBe(
      "outer | persistence failed | cleanup [REDACTED] | write [REDACTED] | cleanup root | write root",
    );
  });

  it("retains both failures from actual async disposal", async () => {
    const body = new Error("body secret");
    const cleanup = new Error("cleanup secret");
    const run = async () => {
      await using resource = {
        [Symbol.asyncDispose]: async () => {
          throw cleanup;
        },
      };
      void resource;
      throw body;
    };
    const failure: unknown = await run().catch((error: unknown) => error);
    expect(collectNestedErrorCandidates(failure)).toEqual([failure, cleanup, body]);
    const formatted = formatErrorMessage(failure, { redact: redactSecrets });
    expect(formatted).toContain("cleanup [REDACTED] | body [REDACTED]");
  });

  it.each([0, null])("retains a downlevel suppressed value %s", (suppressed) => {
    const failure = Object.assign(new Error("disposal failed"), {
      name: "SuppressedError",
      error: new Error("cleanup failed"),
      suppressed,
    });
    expect(format(failure)).toBe(`disposal failed | cleanup failed | ${String(suppressed)}`);
  });

  it("isolates inaccessible messages on VM errors", () => {
    const error: unknown = runInNewContext("new Error('')");
    Object.defineProperty(error, "message", { get: throwRead });
    expect(format(error)).toBe("Error");
    expect(format(withCause("outer failure", error))).toBe("outer failure");
  });

  it("retains VM error messages, causes and aggregate branches", () => {
    const foreign: unknown = runInNewContext(`
      const leaf = Object.assign(new Error("native close failed"), {
        code: "EIO",
        name: "AggregateError",
        errors: [new Error("display-only metadata")],
      });
      Object.assign(new AggregateError([leaf], "cleanup failed", {
        cause: new Error("primary failure"),
      }), { name: "CustomCleanupError" });
    `);
    expect(format(foreign)).toBe("cleanup failed | primary failure | native close failed | EIO");
  });

  it("retains aggregate branches, nested causes and codes once despite cycles", () => {
    const native = Object.assign(new Error("native"), { code: "EIO" });
    const cleanup = new AggregateError([native, native, "second"], "cleanup");
    const outer = new AggregateError([cleanup, native], "turn", { cause: new Error("primary") });
    Object.assign(outer, { code: "REQUEST_FAILED" });
    native.cause = outer;
    expect(format(outer)).toBe("turn | primary | cleanup | native | EIO | second");
    expect(formatErrorMessage(outer, { includeCode: true })).toBe(
      "turn | REQUEST_FAILED | primary | cleanup | native | EIO | second",
    );
  });

  const missingFile = Object.assign(new Error("ENOENT: missing file"), { code: "ENOENT" });
  it.each([
    [
      withCause("API_TOKEN = computeToken()", new Error("sk-abc123456789012345678")),
      "API_TOKEN = computeToken() | sk-abc123456789012345678",
    ],
    [withCause("Parse failed: invalid", new SyntaxError("invalid")), "Parse failed: invalid"],
    [withCause("File not found", missingFile), "File not found | ENOENT: missing file | ENOENT"],
    [null, "null"],
    [undefined, "undefined"],
    [123n, "123"],
    [{ status: 500, code: "EPIPE" }, "status=500 code=EPIPE"],
    [{ status: 404 }, "status=404 code=unknown"],
    [{ code: "ENOENT" }, "status=unknown code=ENOENT"],
    [{ code: 42, why: "boom" }, '{"code":42,"why":"boom"}'],
    [withCause("request", { status: 429 }), "request | status=429 code=unknown"],
    [withCause("request", { statusCode: 429 }), 'request | {"statusCode":429}'],
    [
      withCause("request", { status: 503, code: "E", id: "a" }),
      'request | {"status":503,"code":"E","id":"a"}',
    ],
  ])("formats error details without implicit redaction: case %#", (value, expected) => {
    expect(format(value)).toBe(expected);
  });

  it("falls back to the object tag for circular records", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(format(circular)).toBe("[object Object]");
  });
});

it.each([
  [new Error("boom"), "boom"],
  ["boom", "boom"],
  [{ code: "EPIPE", status: 500 }, "request failed"],
])("toErrorObject preserves messages and structured details: %j", (value, message) => {
  const error = toErrorObject(value, "request failed");
  expect(error.message).toBe(message);
  if (value instanceof Error) {
    expect(error).toBe(value);
  } else if (typeof value === "object") {
    expect(error).toMatchObject({ code: "EPIPE", status: 500 });
    expect(error.cause).toBe(value);
  }
});

describe("toStructuredErrorObject", () => {
  it("preserves Error identity without coercing it", () => {
    class ThrowingToStringError extends Error {
      override toString = throwRead;
    }
    const original = new ThrowingToStringError("request failed", { cause: { code: "EIO" } });
    expect(toStructuredErrorObject(original)).toBe(original);
  });

  it("preserves primitive message and cause semantics", () => {
    const stringError = toStructuredErrorObject("request failed");
    expect(stringError).toMatchObject({ message: "request failed" });
    expect(stringError).not.toHaveProperty("cause");
    for (const value of [undefined, null, 503, false, 503n, Symbol("failure")]) {
      const error = toStructuredErrorObject(value);
      expect(error.message).toBe(String(value));
      expect(Object.hasOwn(error, "cause")).toBe(true);
      expect(error.cause).toBe(value);
    }
  });

  it("copies enumerable string and symbol details while retaining the original cause", () => {
    const detailKey = Symbol("detail");
    const throwingDetailKey = Symbol("throwing detail");
    const details = { code: "EIO", details: { retryable: true }, [detailKey]: "symbol detail" };
    const cause = { ...details };
    Object.defineProperty(cause, "hidden", { value: "secret", enumerable: false });
    withGetter(cause, throwingDetailKey);
    const functionCause = Object.assign(function requestFailure() {}, details);
    for (const [value, message] of [
      [cause, "[object Object]"],
      [functionCause, String(functionCause)],
    ] as const) {
      const error = toStructuredErrorObject(value);
      expect(error).not.toBe(value);
      expect(error.cause).toBe(value);
      expect(error).toMatchObject({ message, ...details });
      expect(Reflect.get(error, detailKey)).toBe("symbol detail");
    }
    const error = toStructuredErrorObject(cause);
    expect(Object.hasOwn(error, throwingDetailKey)).toBe(false);
    expect(error).not.toHaveProperty("hidden");
  });

  it("preserves the base Error for enumeration failures", () => {
    const ownKeysFailure = new Proxy({ code: "EIO" }, { ownKeys: throwRead });
    const descriptorFailure = new Proxy(
      { code: "EIO", status: 503 },
      {
        getOwnPropertyDescriptor(target, key) {
          return key === "status" ? throwRead() : Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    for (const cause of [ownKeysFailure, descriptorFailure]) {
      const error = toStructuredErrorObject(cause);
      expect(error).toMatchObject({ name: "Error", message: "[object Object]" });
      expect(error.cause).toBe(cause);
      expect(error).not.toHaveProperty("code");
      expect(error).not.toHaveProperty("status");
    }
  });

  it("protects Error-owned and prototype-mutating fields without reading them", () => {
    const cause = { constructor: {}, prototype: {}, code: "EIO" };
    const readProtected = vi.fn(() => "spoofed");
    for (const key of ["name", "message", "cause", "stack"]) {
      withGetter(cause, key, readProtected);
    }
    Object.defineProperty(cause, "__proto__", { value: { polluted: true }, enumerable: true });
    const error = toStructuredErrorObject(cause);
    expect(readProtected).not.toHaveBeenCalled();
    expect(error).toMatchObject({ name: "Error", message: "[object Object]", code: "EIO" });
    expect(error.cause).toBe(cause);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(error, key)).toBe(false);
    }
  });
});

it("toStringifiedError preserves Error identity and stringifies every other value", () => {
  const error = new Error("boom");
  const objectError = toStringifiedError({ ok: true });
  expect(toStringifiedError(error)).toBe(error);
  expect(toStringifiedError("failure")).toMatchObject({ message: "failure" });
  expect(objectError).toMatchObject({ message: "[object Object]" });
  expect(objectError).not.toHaveProperty("cause");
  expect(objectError).not.toHaveProperty("ok");
  expect(toStringifiedError(null)).toMatchObject({ message: "null" });
});

it("coerceErrorMessage preserves Error messages exactly and stringifies other values", () => {
  expect(coerceErrorMessage(new Error(""))).toBe("");
  expect(coerceErrorMessage(new Error(" boom "))).toBe(" boom ");
  expect(coerceErrorMessage("failure")).toBe("failure");
  expect(coerceErrorMessage(null)).toBe("null");
});

it.each([
  ["hi", "hi"],
  [null, "null"],
  [42, "42"],
  [{ ok: true }, '{"ok":true}'],
  [undefined, "[object Undefined]"],
  [Symbol("value"), "[object Symbol]"],
  [() => {}, "[object Function]"],
])("stringifyNonErrorCause renders %s", (value, expected) => {
  expect(stringifyNonErrorCause(value)).toBe(expected);
});

it.each([
  ["Error", "version resolution failed", "Error", "Error: version resolution failed"],
  ["Error", "boom", "Error: boom", "Error: boom"],
  ["PermissionError", "denied", "PermissionError", "PermissionError: denied"],
  ["Error", "multi", "", "Error: multi"],
])("formats stack headers for %s: %s", (name, message, header, expected) => {
  const frame = "    at f (source.js:1:1)";
  const stack = header ? `${header}\n${frame}` : frame;
  const error = Object.assign(new Error(message), { name, stack });
  expect(formatErrorStackWithMessage(error)).toBe(`${expected}\n${frame}`);
});

it("formatErrorStackWithMessage falls back to the message without a stack", () => {
  expect(formatErrorStackWithMessage(Object.assign(new Error("solo"), { stack: "" }))).toBe("solo");
});
