import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { gunzipSync } from "node:zlib";

const MAX_OTLP_TRACE_BODY_BYTES = 1_048_576;

export type QaOtlpTraceSpan = {
  name: string;
};

type QaOtlpTraceRequest = {
  path: string;
  status: number;
  spanCount: number;
};

class QaOtlpProtoReader {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  done(): boolean {
    return this.offset === this.buffer.length;
  }

  varint(): number {
    let value = 0;
    let shift = 0;
    while (this.offset < this.buffer.length && shift <= 49) {
      const byte = this.buffer[this.offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += 7;
    }
    throw new Error("invalid or truncated OTLP protobuf varint");
  }

  tag(): { field: number; wire: number } {
    const value = this.varint();
    return { field: value >>> 3, wire: value & 7 };
  }

  bytes(): Uint8Array {
    const length = this.varint();
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new Error("truncated OTLP protobuf bytes");
    }
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
      return;
    }
    if (wire === 2) {
      this.bytes();
      return;
    }
    const size = wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (size < 0 || this.offset + size > this.buffer.length) {
      throw new Error(`invalid OTLP protobuf wire type ${wire}`);
    }
    this.offset += size;
  }
}

function decodeNestedMessages(message: Uint8Array, wantedField: number): Uint8Array[] {
  const reader = new QaOtlpProtoReader(message);
  const values: Uint8Array[] = [];
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === wantedField && wire === 2) {
      values.push(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  return values;
}

function decodeOtlpTraceSpans(body: Uint8Array): QaOtlpTraceSpan[] {
  const spans: QaOtlpTraceSpan[] = [];
  for (const resource of decodeNestedMessages(body, 1)) {
    for (const scope of decodeNestedMessages(resource, 2)) {
      for (const encodedSpan of decodeNestedMessages(scope, 2)) {
        const names = decodeNestedMessages(encodedSpan, 5);
        const name = names.length === 1 ? new TextDecoder().decode(names[0]).trim() : "";
        if (name) {
          spans.push({ name });
        }
      }
    }
  }
  return spans;
}

async function readBoundedTraceBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > MAX_OTLP_TRACE_BODY_BYTES) {
      throw new Error("OTLP trace request exceeds the bounded QA body limit");
    }
    chunks.push(bytes);
  }
  const compressed = Buffer.concat(chunks, length);
  const encoding = request.headers["content-encoding"];
  if (encoding === undefined || encoding === "identity") {
    return compressed;
  }
  if (encoding !== "gzip") {
    throw new Error(`unsupported OTLP trace content encoding: ${String(encoding)}`);
  }
  return gunzipSync(compressed, { maxOutputLength: MAX_OTLP_TRACE_BODY_BYTES });
}

export async function startQaOtlpTraceReceiver(options?: {
  disallowedNeedles?: readonly string[];
}) {
  const spans: QaOtlpTraceSpan[] = [];
  const requests: QaOtlpTraceRequest[] = [];
  const leakedNeedles = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      const requestPath = request.url ?? "";
      if (
        request.method !== "POST" ||
        !["/v1/traces", "/v1/metrics", "/v1/logs"].includes(requestPath)
      ) {
        response.writeHead(404).end();
        return;
      }
      if (requestPath !== "/v1/traces") {
        for await (const _chunk of request) {
          // Drain sibling signals so the real exporter cannot stall on its connection.
        }
        requests.push({ path: requestPath, status: 200, spanCount: 0 });
        response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
        return;
      }
      try {
        const body = await readBoundedTraceBody(request);
        const decoded = decodeOtlpTraceSpans(body);
        if (decoded.length === 0) {
          throw new Error("OTLP trace request contains no decodable named spans");
        }
        for (const needle of options?.disallowedNeedles ?? []) {
          if (needle && body.includes(Buffer.from(needle, "utf8"))) {
            leakedNeedles.add(needle);
          }
        }
        spans.push(...decoded);
        requests.push({ path: requestPath, status: 200, spanCount: decoded.length });
        response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
      } catch (error) {
        requests.push({ path: requestPath, status: 400, spanCount: 0 });
        response
          .writeHead(400, { "content-type": "text/plain" })
          .end(error instanceof Error ? error.message : "invalid OTLP trace request");
      }
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      } else {
        response.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to bind the QA OTLP trace receiver");
  }
  let closePromise: Promise<void> | undefined;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    spans,
    requests,
    leakedNeedles,
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closePromise;
    },
  };
}
