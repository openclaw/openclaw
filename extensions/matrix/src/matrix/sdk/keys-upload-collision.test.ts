import { describe, expect, it } from "vitest";
import {
  isKeysUploadCollision400,
  synthesizeKeysUploadCollisionResponse,
} from "./keys-upload-collision.js";

const COLLISION_BODY = JSON.stringify({
  errcode: "M_INVALID_PARAM",
  error: "signed_curve25519:AAAAAAAAAA0 already exists",
});

const NON_COLLISION_400_BODY = JSON.stringify({
  errcode: "M_FORBIDDEN",
  error: "Cross-signing requires UIA",
});

const KEYS_UPLOAD_URL = "https://matrix.example.com/_matrix/client/v3/keys/upload";

describe("isKeysUploadCollision400", () => {
  it("returns true for a 400 POST to /keys/upload with a collision body", () => {
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "POST",
        status: 400,
        body: COLLISION_BODY,
      }),
    ).toBe(true);
  });

  it("matches lowercase 'curve25519' alongside 'signed_curve25519'", () => {
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "POST",
        status: 400,
        body: JSON.stringify({
          errcode: "M_INVALID_PARAM",
          error: "curve25519:abc123 already exists",
        }),
      }),
    ).toBe(true);
  });

  it("returns false when the status is not 400", () => {
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "POST",
        status: 200,
        body: COLLISION_BODY,
      }),
    ).toBe(false);
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "POST",
        status: 401,
        body: COLLISION_BODY,
      }),
    ).toBe(false);
  });

  it("returns false when the method is not POST", () => {
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "GET",
        status: 400,
        body: COLLISION_BODY,
      }),
    ).toBe(false);
  });

  it("returns false when the path is not /keys/upload", () => {
    expect(
      isKeysUploadCollision400({
        url: "https://matrix.example.com/_matrix/client/v3/keys/query",
        method: "POST",
        status: 400,
        body: COLLISION_BODY,
      }),
    ).toBe(false);
    expect(
      isKeysUploadCollision400({
        url: "https://matrix.example.com/_matrix/client/v3/keys/device_signing/upload",
        method: "POST",
        status: 400,
        body: COLLISION_BODY,
      }),
    ).toBe(false);
  });

  it("returns false for a non-collision 400 body on /keys/upload", () => {
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "POST",
        status: 400,
        body: NON_COLLISION_400_BODY,
      }),
    ).toBe(false);
  });

  it("returns false when the URL cannot be parsed", () => {
    expect(
      isKeysUploadCollision400({
        url: "not a url",
        method: "POST",
        status: 400,
        body: COLLISION_BODY,
      }),
    ).toBe(false);
  });

  it("returns false for malformed body that does not match the regex", () => {
    expect(
      isKeysUploadCollision400({
        url: KEYS_UPLOAD_URL,
        method: "POST",
        status: 400,
        body: "{ not json",
      }),
    ).toBe(false);
  });
});

describe("synthesizeKeysUploadCollisionResponse", () => {
  it("returns a 200 with empty one_time_key_counts and the requested URL", async () => {
    const response = synthesizeKeysUploadCollisionResponse(KEYS_UPLOAD_URL);
    expect(response.status).toBe(200);
    expect(response.url).toBe(KEYS_UPLOAD_URL);
    const body = await response.json();
    expect(body).toEqual({ one_time_key_counts: {} });
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
