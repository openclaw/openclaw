const REQUEST_BODY = Symbol("modelRequestBody");

export type EncodedModelRequestBody = { body: Uint8Array<ArrayBuffer>; stream: boolean };

/** A slice of JSON.stringify output; only keys need decoding to inspect its shape. */
class ModelRequestJson {
  readonly json: string;

  constructor(json: string) {
    this.json = json;
  }

  *members(): Generator<[string, ModelRequestJson]> {
    const object = this.json[0] === "{";
    if (!object && this.json[0] !== "[") {
      return;
    }
    let index = 1;
    let item = 0;
    while (index < this.json.length - 1) {
      let key = String(item++);
      if (object) {
        const end = this.valueEnd(index);
        const encodedKey = this.json.slice(index + 1, end - 1);
        key = encodedKey.includes("\\")
          ? (JSON.parse(this.json.slice(index, end)) as string)
          : encodedKey;
        index = end + 1;
      }
      const end = this.valueEnd(index);
      yield [key, new ModelRequestJson(this.json.slice(index, end))];
      index = end + 1;
    }
  }

  private valueEnd(start: number): number {
    let depth = 0;
    for (let index = start; index < this.json.length; index++) {
      const char = this.json[index];
      if (char === '"') {
        let escaped: boolean;
        do {
          index = this.json.indexOf('"', index + 1);
          let slash = index - 1;
          while (this.json[slash] === "\\") {
            slash--;
          }
          escaped = (index - slash) % 2 === 0;
        } while (escaped);
        if (depth === 0) {
          return index + 1;
        }
      } else if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        if (depth === 0) {
          return index;
        }
        depth--;
        if (depth === 0) {
          return index + 1;
        }
      } else if (depth === 0 && (char === "," || char === ":")) {
        return index;
      }
    }
    return this.json.length;
  }
}
type ModelRequestBodyState = {
  enabled?: boolean;
  encode?: (payload: unknown) => Promise<EncodedModelRequestBody>;
  onEncoded?: (body: Blob, payload: unknown) => void;
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
): EncodedModelRequestBody & { json: ModelRequestJson | undefined } {
  const json = JSON.stringify(payload);
  const request = json === undefined ? undefined : new ModelRequestJson(json);
  let stream = false;
  if (request?.json[0] === "{") {
    for (const [key, value] of request.members()) {
      if (key === "stream") {
        stream = value.json === "true";
        break;
      }
    }
  }
  // Only detached observers need a second graph. The immutable JSON owns wire facts.
  if (onSerializedPayload) {
    onSerializedPayload(json === undefined ? undefined : JSON.parse(json));
  }
  return {
    body: new TextEncoder().encode(json),
    stream,
    json: request,
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
    // Fetch copies mutable byte arrays; an immutable body can also serve retained fork replay.
    const body = new Blob([encoded.body]);
    state.onEncoded?.(body, payload);
    state.onBytes?.(body.size);
    encodedBodyStreams.set(body, encoded.stream);
    return { body, headers: { "content-type": "application/json" } };
  };
}
