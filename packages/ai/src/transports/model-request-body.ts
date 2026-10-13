const REQUEST_BODY = Symbol("modelRequestBody");

export type EncodedModelRequestBody = { body: Uint8Array<ArrayBuffer>; stream: boolean };
type ModelRequestBodyState = {
  enabled?: boolean;
  encode?: (payload: unknown) => Promise<EncodedModelRequestBody>;
  onBytes?: (bytes: number) => void;
};

/** Call-local state survives option spreads; no payload is cached across requests. */
export function modelRequestBodyState(
  options: object,
  inheritFrom?: object,
): ModelRequestBodyState {
  const value =
    Reflect.get(options, REQUEST_BODY) ?? (inheritFrom && Reflect.get(inheritFrom, REQUEST_BODY));
  // SAFETY: Only this module writes the private symbol, always with ModelRequestBodyState.
  const state = (value as ModelRequestBodyState | undefined) ?? {};
  Reflect.set(options, REQUEST_BODY, state);
  return state;
}

export function serializeModelRequestBody(
  payload: unknown,
  onSerializedPayload?: (payload: unknown) => void,
): EncodedModelRequestBody {
  const json = JSON.stringify(payload);
  const serialized: unknown = json === undefined ? undefined : JSON.parse(json);
  // Preserve the wire fact even when the observer changes its detached parsed value.
  const stream =
    typeof serialized === "object" &&
    serialized !== null &&
    "stream" in serialized &&
    serialized.stream === true;
  onSerializedPayload?.(serialized);
  return {
    body: new TextEncoder().encode(json),
    stream,
  };
}

const encodedBodyStreams = new WeakMap<object, boolean>();

export function encodedModelRequestBodyStream(body: unknown): boolean | undefined {
  return typeof body === "object" && body !== null ? encodedBodyStreams.get(body) : undefined;
}

/** SDK RequestOptions.body overrides encoding while the original params retain stream metadata. */
export function prepareModelRequestBody(options: object | undefined) {
  const state = options ? modelRequestBodyState(options) : {};
  state.enabled = true;
  return async (payload: unknown) => {
    const encoded = state.encode ? await state.encode(payload) : serializeModelRequestBody(payload);
    state.onBytes?.(encoded.body.byteLength);
    encodedBodyStreams.set(encoded.body, encoded.stream);
    return { body: encoded.body, headers: { "content-type": "application/json" } };
  };
}
