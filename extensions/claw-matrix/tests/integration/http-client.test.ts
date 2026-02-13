import assert from "node:assert/strict";
/**
 * Integration test scaffolding: HTTP client against mock homeserver.
 *
 * Demonstrates how to wire up the mock homeserver with the real
 * matrixFetch/initHttpClient for end-to-end request testing.
 */
import { describe, it, before, after } from "node:test";
import { initHttpClient, matrixFetch, MatrixApiError } from "../../src/client/http.js";
import { MockHomeserver } from "./mock-homeserver.js";

describe("integration: HTTP client with mock homeserver", () => {
  const server = new MockHomeserver({ accessToken: "test-token-123" });

  before(async () => {
    await server.start();
    initHttpClient(server.url, "test-token-123");
  });

  after(async () => {
    await server.stop();
  });

  it("should fetch /sync successfully", async () => {
    server.syncResponse = {
      next_batch: "s42",
      rooms: { join: {}, invite: {}, leave: {} },
    };

    const result = await matrixFetch<{ next_batch: string }>(
      "GET",
      "/_matrix/client/v3/sync",
      undefined,
      { skipRateLimit: true },
    );
    assert.equal(result.next_batch, "s42");
  });

  it("should send events via PUT", async () => {
    server.sentEvents = [];
    const roomId = "!test:mock.server";
    const txnId = "txn_test_1";

    await matrixFetch(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      { msgtype: "m.text", body: "Hello from test" },
      { skipRateLimit: true },
    );

    assert.equal(server.sentEvents.length, 1);
    assert.equal(server.sentEvents[0].roomId, roomId);
    assert.equal(server.sentEvents[0].eventType, "m.room.message");
    assert.deepEqual(server.sentEvents[0].body, { msgtype: "m.text", body: "Hello from test" });
  });

  it("should resolve room aliases via directory API", async () => {
    server.aliasMap.set("#test:mock.server", "!resolved:mock.server");

    const result = await matrixFetch<{ room_id: string }>(
      "GET",
      `/_matrix/client/v3/directory/room/${encodeURIComponent("#test:mock.server")}`,
      undefined,
      { skipRateLimit: true },
    );
    assert.equal(result.room_id, "!resolved:mock.server");
  });

  it("should handle 404 as MatrixApiError", async () => {
    await assert.rejects(
      () =>
        matrixFetch("GET", "/_matrix/client/v3/directory/room/%23nonexistent:x", undefined, {
          skipRateLimit: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof MatrixApiError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.errcode, "M_NOT_FOUND");
        return true;
      },
    );
  });

  it("should handle auth failure", async () => {
    // Temporarily use wrong token
    initHttpClient(server.url, "wrong-token");
    await assert.rejects(
      () => matrixFetch("GET", "/_matrix/client/v3/sync", undefined, { skipRateLimit: true }),
      (err: unknown) => {
        assert.ok(err instanceof MatrixApiError);
        assert.equal(err.statusCode, 401);
        return true;
      },
    );
    // Restore correct token
    initHttpClient(server.url, "test-token-123");
  });

  it("should fetch m.direct account data", async () => {
    server.mDirectData = {
      "@friend:mock.server": ["!dm-room:mock.server"],
    };

    const result = await matrixFetch<Record<string, string[]>>(
      "GET",
      `/_matrix/client/v3/user/${encodeURIComponent("@bot:mock.server")}/account_data/m.direct`,
      undefined,
      { skipRateLimit: true },
    );
    assert.deepEqual(result["@friend:mock.server"], ["!dm-room:mock.server"]);
  });

  it("should upload media", async () => {
    const result = await matrixFetch<{ content_uri: string }>(
      "POST",
      "/_matrix/media/v3/upload?filename=test.txt",
      undefined, // body would be binary in real usage
      { skipRateLimit: true },
    );
    assert.ok(result.content_uri.startsWith("mxc://"));
  });

  it("should handle key upload", async () => {
    const result = await matrixFetch<{ one_time_key_counts: Record<string, number> }>(
      "POST",
      "/_matrix/client/v3/keys/upload",
      { device_keys: {}, one_time_keys: {} },
      { skipRateLimit: true },
    );
    assert.ok(result.one_time_key_counts);
  });
});
