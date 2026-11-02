import { isProxy } from "node:util/types";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import type { Model } from "@openclaw/llm-core";
import { getAiTransportHost } from "../host.js";
import type { AnthropicOptions } from "../provider-options.js";
import { markEncodedModelRequestBody } from "./model-request-body.js";

// Converted identities are owned by frozen history; neither this map nor its
// immutable byte fragments extend the lifetime of that history.
const fragments = new WeakMap<object, Blob>();

function copyPlainData<T>(value: T, retainFrozen = false, copies = new Map<object, unknown>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (retainFrozen && getAiTransportHost().immutableData?.isDeeplyFrozenPlainData(value)) {
    return value;
  }
  if (copies.has(value)) {
    // SAFETY: The map only contains copies of the corresponding admitted plain value.
    return copies.get(value) as T;
  }
  const copy = Array.isArray(value) ? [] : { ...value };
  if (Array.isArray(value)) {
    Reflect.set(copy, "length", value.length);
  }
  if (Object.getPrototypeOf(value) === null) {
    Object.setPrototypeOf(copy, null);
  }
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") {
      continue;
    }
    const child = copyPlainData(Reflect.get(value, key), retainFrozen, copies);
    if (
      Object.hasOwn(copy, key) ||
      (key !== "__proto__" && Object.prototype.propertyIsEnumerable.call(value, key))
    ) {
      Reflect.set(copy, key, child);
    } else {
      Object.defineProperty(copy, key, {
        value: child,
        enumerable: Object.prototype.propertyIsEnumerable.call(value, key),
        writable: true,
        configurable: true,
      });
    }
  }
  // SAFETY: The admitted plain graph keeps its shape; only its containers are detached.
  return copy as T;
}

function samePlainData(left: unknown, right: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (isProxy(right) || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
    return false;
  }
  if (seen.has(left)) {
    return seen.get(left) === right;
  }
  seen.set(left, right);
  const keys = Reflect.ownKeys(left);
  const otherKeys = Reflect.ownKeys(right);
  if (
    keys.length !== otherKeys.length ||
    (Array.isArray(left) && left.length !== Reflect.get(right, "length"))
  ) {
    return false;
  }
  let index = 0;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(right, key);
    if (
      key !== otherKeys[index++] ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      Object.prototype.propertyIsEnumerable.call(left, key) !== descriptor.enumerable ||
      !samePlainData(Reflect.get(left, key), descriptor.value, seen)
    ) {
      return false;
    }
  }
  return true;
}

/** Hooks receive editable containers; any edit opts the whole request out of fragment reuse. */
export async function applyAnthropicPayloadHook(
  params: MessageCreateParamsStreaming,
  model: Model<"anthropic-messages">,
  options: AnthropicOptions | undefined,
): Promise<{
  params: MessageCreateParamsStreaming;
  messageSources?: readonly unknown[] | null;
}> {
  if (!options?.onPayload) {
    return { params };
  }
  const plain = getAiTransportHost().immutableData?.isPlainData;
  const snapshot = plain?.(params) ? copyPlainData(params, true) : undefined;
  // Opaque caller values retain their original behavior. Converter-owned plain
  // messages still need detaching when an unrelated envelope value is opaque.
  const editable = snapshot
    ? copyPlainData(params)
    : {
        ...params,
        messages: params.messages.map((message) =>
          plain?.(message) ? copyPlainData(message) : message,
        ),
      };
  const replacement = await options.onPayload(editable, model);
  const unchanged =
    (replacement === undefined || replacement === editable) &&
    snapshot !== undefined &&
    samePlainData(snapshot, editable);
  return {
    // SAFETY: The public payload hook owns its replacement shape.
    params: (replacement === undefined ? editable : replacement) as MessageCreateParamsStreaming,
    messageSources: unchanged ? snapshot.messages : null,
  };
}

/** Assemble immutable history bytes while encoding the envelope and mutable tail each time. */
export function serializeAnthropicRequestBody(
  payload: MessageCreateParamsStreaming,
  messageSources?: readonly unknown[] | null,
): string | Blob {
  const immutable = getAiTransportHost().immutableData;
  if (
    messageSources === null ||
    !immutable?.isPlainData ||
    // An unchanged hook already proved the entire plain graph; the request
    // contract only adjusts owner-created envelope fields afterward.
    (messageSources === undefined && !immutable.isPlainData(payload)) ||
    "toJSON" in Object.prototype ||
    "toJSON" in Array.prototype ||
    !Array.isArray(payload.messages)
  ) {
    return JSON.stringify(payload);
  }
  const messages = messageSources ?? payload.messages;
  const parts: Array<string | Blob> = [];
  let envelope = "{";
  let separator = "";
  for (const key of Object.keys(payload)) {
    const value: unknown = Reflect.get(payload, key);
    if (key === "messages") {
      parts.push(`${envelope}${separator}"messages":[`);
      envelope = "]";
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        const reusable =
          message !== null &&
          typeof message === "object" &&
          immutable.isDeeplyFrozenPlainData(message);
        let fragment = reusable ? fragments.get(message) : undefined;
        if (!fragment) {
          fragment = new Blob(["," + JSON.stringify(message)]);
          if (reusable) {
            fragments.set(message, fragment);
          }
        }
        parts.push(index === 0 ? fragment.slice(1) : fragment);
      }
    } else {
      const json = JSON.stringify(value);
      if (json === undefined) {
        continue;
      }
      envelope += `${separator}${JSON.stringify(key)}:${json}`;
    }
    separator = ",";
  }
  parts.push(`${envelope}}`);
  const body = new Blob(parts, { type: "application/json" });
  markEncodedModelRequestBody(body, payload.stream);
  return body;
}
