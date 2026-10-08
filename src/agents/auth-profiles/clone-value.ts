import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from "node:util/types";

/** Keep immutable credential strings in place while detaching their JSON containers. */
export function cloneAuthProfileJsonValue<T>(input: T): T {
  const ancestors = new Set<object>();
  const clone = (current: unknown, key: string): unknown => {
    let value = current;
    if (value !== null && (typeof value === "object" || typeof value === "bigint")) {
      const toJSON: unknown = Reflect.get(Object(value), "toJSON");
      if (typeof toJSON === "function") {
        value = Reflect.apply(toJSON, value, [key]);
      }
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`AuthProfileStore contains non-JSON value: ${typeof value}`);
    }
    if (isNumberObject(value)) {
      value = Number(value);
    } else if (isStringObject(value)) {
      value = String(value);
    } else if (isBooleanObject(value)) {
      value = Boolean.prototype.valueOf.call(value);
    } else if (isBigIntObject(value)) {
      throw new TypeError("AuthProfileStore contains non-JSON value: bigint");
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (ancestors.has(value)) {
      throw new TypeError("AuthProfileStore contains a circular JSON value");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return Array.from(
          { length: value.length },
          (_, index) => clone(value[index], `${index}`) ?? null,
        );
      }
      return Object.fromEntries(
        Object.keys(value).flatMap((property) => {
          const copied = clone(Reflect.get(value, property), property);
          return copied === undefined ? [] : [[property, copied] as const];
        }),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  // SAFETY: This preserves the auth store's existing JSON-normalized cloning contract.
  return clone(input, "") as T;
}
