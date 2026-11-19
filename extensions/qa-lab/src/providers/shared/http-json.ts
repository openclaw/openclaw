import type { ServerResponse } from "node:http";
import { Readable, pipeline } from "node:stream";

/** Serialize retained evidence one record at a time, with stream backpressure. */
export function writeJsonArray(res: ServerResponse, records: readonly unknown[]) {
  function* chunks() {
    yield "[";
    for (let index = 0; index < records.length; index++) {
      if (index > 0) {
        yield ",";
      }
      yield JSON.stringify(records[index]);
    }
    yield "]\n";
  }
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  // A serialization failure or disconnected reader must abort, not finish a partial array.
  pipeline(Readable.from(chunks(), { objectMode: false }), res, (error) => {
    if (error) {
      res.destroy(error);
    }
  });
}

export function writeJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}
