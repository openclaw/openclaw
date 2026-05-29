// matrix-rust-sdk's OlmMachine occasionally emits a `/keys/upload` request
// containing a one-time-key whose `<algorithm>:<id>` collides with an OTK ID
// already published earlier in the same session. Synapse rejects the
// duplicate with HTTP 400 and a body whose `error` field matches
// "<algorithm>:<id> already exists" (typically signed_curve25519). The 4xx is
// not retried by matrix-js-sdk's `requestWithRetry`, so the bootstrap call
// fails outright and never recovers.
//
// Until the upstream rust-sdk OTK ID generation/tracking issue is fixed, we
// rewrite that single failure mode at the fetchFn boundary into a synthetic
// 200 with empty `one_time_key_counts`. The empty counts signal to the rust
// SDK's outgoing-request loop that it should mint fresh OTKs (with new IDs)
// and re-upload them. Semantically the swallow is correct — the colliding
// key is genuinely already on the server.

const COLLISION_BODY_REGEX = /(?:signed_curve25519|curve25519):[A-Za-z0-9_-]+ already exists/i;

const KEYS_UPLOAD_PATH_SUFFIX = "/keys/upload";

export function isKeysUploadCollision400(params: {
  url: string;
  method: string;
  status: number;
  body: string;
}): boolean {
  if (params.status !== 400) {
    return false;
  }
  if (params.method.toUpperCase() !== "POST") {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(params.url).pathname;
  } catch {
    return false;
  }
  if (!pathname.endsWith(KEYS_UPLOAD_PATH_SUFFIX)) {
    return false;
  }
  return COLLISION_BODY_REGEX.test(params.body);
}

export function synthesizeKeysUploadCollisionResponse(url: string): Response {
  const response = new Response(JSON.stringify({ one_time_key_counts: {} }), {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "application/json",
    },
  });
  try {
    Object.defineProperty(response, "url", { value: url, configurable: true });
  } catch {
    // Response.url is read-only in some runtimes; metadata is best-effort only.
  }
  return response;
}
