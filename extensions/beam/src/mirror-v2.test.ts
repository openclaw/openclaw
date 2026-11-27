import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  enrollBeamMirrorV2,
  inspectBeamMirrorV2Enrollment,
  prepareBeamMirrorV2Intent,
  publishBeamMirrorV2,
  requireBeamMirrorPublisher,
  type BeamMirrorV2Head,
} from "./mirror-v2.js";

const beamId = "a".repeat(32);
const raw = Buffer.from(
  JSON.stringify(
    {
      version: 2,
      beamId,
      source: "openclaw",
      title: "A",
      updatedAt: "2026-01-01T00:00:00Z",
      completed: false,
      items: [{ type: "userMessage", text: "fixture" }],
    },
    undefined,
    2,
  ) + "\n",
);
const prior: BeamMirrorV2Head = {
  publicationId: "opaque.generation",
  revision: '"prior"',
  sha256: "sha256:" + "b".repeat(64),
};
const intent = prepareBeamMirrorV2Intent(raw, prior);
const head: BeamMirrorV2Head = { ...prior, revision: '"r1"', sha256: intent.sha256 };
const scope = {
  beamId,
  raw,
  signal: new AbortController().signal,
  assertCurrent: () => {},
  token: "synthetic-mirror-token",
};

function receipt(h: BeamMirrorV2Head, state = "writable") {
  return {
    beamId,
    publicationId: h.publicationId,
    revision: h.revision,
    digest: h.sha256,
    state,
    disposition: "applied",
    canRelease: true,
  };
}

function serve(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
  run: (endpoint: string) => Promise<void>,
) {
  return withServer(
    (req, res) => {
      void buffer(req).then(
        (body) => handler(req, res, body),
        () => res.destroy(),
      );
    },
    (origin) => run(origin + "/mounted/api/v2/beam"),
  );
}

it("recovers a lost update acknowledgement using the saved ID, precondition and original bytes", async () => {
  const received: Array<{ key: unknown; condition: unknown; bytes: Buffer; auth: unknown }> = [];
  await serve(
    (req, res, body) => {
      if (req.method === "GET") {
        res.end(JSON.stringify(receipt(received.length ? head : prior)));
        return;
      }
      received.push({
        key: req.headers["idempotency-key"],
        condition: req.headers["if-match"],
        bytes: body,
        auth: req.headers.authorization,
      });
      if (received.length === 1) {
        res.destroy();
      } else {
        res.end(JSON.stringify(receipt(head)));
      }
    },
    async (endpoint) => {
      const params = { ...scope, endpoint, intent };
      await expect(publishBeamMirrorV2(params)).rejects.toThrow("saved request");
      expect(await publishBeamMirrorV2(params)).toEqual({ state: "published", head });
      expect(received).toHaveLength(2);
      for (const entry of received) {
        expect(entry).toEqual({
          key: intent.requestId,
          condition: prior.revision,
          bytes: raw,
          auth: "Bearer synthetic-mirror-token",
        });
      }
    },
  );
});

it.each([
  [404, undefined, "conflict"],
  [200, receipt({ ...prior, publicationId: "different" }), "conflict"],
  [200, receipt({ ...prior, sha256: head.sha256 }), "conflict"],
  [200, receipt(prior, "released"), "released"],
] as const)("fences missing, changed or retired heads before PUT", async (status, body, state) => {
  const methods: Array<string | undefined> = [];
  await serve(
    (req, res) => {
      methods.push(req.method);
      res.statusCode = status;
      res.end(JSON.stringify(body));
    },
    async (endpoint) => {
      expect(
        await publishBeamMirrorV2({
          ...scope,
          endpoint,
          intent: prepareBeamMirrorV2Intent(raw, prior),
        }),
      ).toEqual({ state });
      expect(methods).toEqual(["GET"]);
    },
  );
});

it("rejects redirects and expired or mismatched saved update intents without dispatching a PUT", async () => {
  const paths: Array<string | undefined> = [];
  await serve(
    (req, res) => {
      paths.push(req.url);
      res.writeHead(307, { location: "/must-not-follow" }).end();
    },
    async (endpoint) => {
      const params = { ...scope, endpoint, intent };
      expect(await publishBeamMirrorV2(params)).toEqual({ state: "conflict" });
      expect(await publishBeamMirrorV2({ ...params, intent: { ...intent, createdAt: 1 } })).toEqual(
        { state: "conflict" },
      );
      await expect(
        publishBeamMirrorV2({
          ...params,
          intent: { ...intent, sha256: "sha256:" + "0".repeat(64) },
        }),
      ).rejects.toThrow("intent");
      expect(paths).toEqual([`/mounted/api/v2/beam/snapshots/${beamId}/head`]);
    },
  );
});

it("rechecks source consent before transmitting conversation bytes", async () => {
  let active = true;
  const methods: Array<string | undefined> = [];
  const assertCurrent = vi.fn(() => {
    if (!active) {
      throw new Error("enrollment ended");
    }
  });
  await serve(
    (req, res) => {
      methods.push(req.method);
      active = false;
      res.writeHead(404).end();
    },
    async (endpoint) => {
      await expect(
        publishBeamMirrorV2({ ...scope, endpoint, intent, assertCurrent }),
      ).rejects.toThrow("enrollment ended");
      expect(methods).toEqual(["GET"]);
    },
  );
});

it.each([
  [prior.publicationId, "released"],
  ["replaced.generation", "conflict"],
] as const)("ties a concurrent release to the stored generation", async (publicationId, state) => {
  const methods: Array<string | undefined> = [];
  await serve(
    (req, res) => {
      methods.push(req.method);
      if (methods.length === 1) {
        res.end(JSON.stringify(receipt(prior)));
      } else if (req.method === "PUT") {
        res.writeHead(409).end(JSON.stringify({ error: { code: "released" } }));
      } else {
        res.end(JSON.stringify(receipt({ ...prior, publicationId }, "released")));
      }
    },
    async (endpoint) => {
      expect(
        await publishBeamMirrorV2({
          ...scope,
          endpoint,
          intent: prepareBeamMirrorV2Intent(raw, prior),
        }),
      ).toEqual({ state });
      expect(methods).toEqual(["GET", "PUT", "GET"]);
    },
  );
});

it("creates only on an explicit enrollment and records the generation named in the receipt", async () => {
  const operations: Array<[string | undefined, string | string[] | undefined, string | undefined]> =
    [];
  await serve(
    (req, res) => {
      operations.push([req.method, req.headers["if-none-match"], req.headers["if-match"]]);
      res.writeHead(201).end(JSON.stringify(receipt(head)));
    },
    async (endpoint) => {
      expect(await enrollBeamMirrorV2({ ...scope, endpoint, requestId: intent.requestId })).toEqual(
        { state: "published", head },
      );
      expect(operations).toEqual([["PUT", "*", undefined]]);
    },
  );
});

it("requires verified publisher capabilities before enrollment and an owner-attested first receipt", async () => {
  const methods: string[] = [];
  await serve(
    (req, res) => {
      methods.push(req.method ?? "");
      if (req.url?.endsWith("/capabilities")) {
        const allowed = req.headers.authorization === "Bearer verified";
        res.end(
          JSON.stringify({
            protocol: 2,
            operations: allowed ? ["publish", "release"] : ["publish"],
          }),
        );
        return;
      }
      res.writeHead(201).end(JSON.stringify({ ...receipt(head), canRelease: false }));
    },
    async (endpoint) => {
      await expect(requireBeamMirrorPublisher({ ...scope, endpoint })).rejects.toThrow(
        "verified publisher",
      );
      await requireBeamMirrorPublisher({ ...scope, endpoint, token: "verified" });
      await expect(
        enrollBeamMirrorV2({ ...scope, endpoint, requestId: intent.requestId }),
      ).rejects.toThrow("did not attest");
      expect(methods).toEqual(["GET", "GET", "PUT"]);
    },
  );
});

it.each([
  [head, "writable", { state: "observed", head }],
  [prior, "writable", { state: "conflict" }],
  [head, "released", { state: "released" }],
] as const)(
  "reads a matching publication for explicit rebind without enrolling or writing",
  async (found, state, expected) => {
    const methods: Array<string | undefined> = [];
    await serve(
      (req, res) => {
        methods.push(req.method);
        res.end(JSON.stringify(receipt(found, state)));
      },
      async (endpoint) => {
        expect(
          await inspectBeamMirrorV2Enrollment({ ...scope, endpoint, sha256: head.sha256 }),
        ).toEqual(expected);
        expect(methods).toEqual(["GET"]);
      },
    );
  },
);

it("rejects a teammate or receiver without publisher attestation despite matching the exact packet and generation", async () => {
  const methods: string[] = [];
  await serve(
    (req, res) => {
      methods.push(req.method ?? "");
      const canRelease = req.headers.authorization === "Bearer rotated-owner";
      res.end(JSON.stringify({ ...receipt(head), canRelease }));
    },
    async (endpoint) => {
      const inspect = (token: string) =>
        inspectBeamMirrorV2Enrollment({ ...scope, endpoint, token, sha256: head.sha256 });
      expect(await inspect("teammate")).toEqual({ state: "conflict" });
      expect(await inspect("rotated-owner")).toEqual({ state: "observed", head });
      expect(methods).toEqual(["GET", "GET"]);
    },
  );
});
