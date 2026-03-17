import { UrbitAuthError } from "./errors.js";
import { urbitFetch } from "./fetch.js";
async function authenticate(url, code, options = {}) {
  const { response, release } = await urbitFetch({
    baseUrl: url,
    path: "/~/login",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: code }).toString()
    },
    ssrfPolicy: options.ssrfPolicy,
    lookupFn: options.lookupFn,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 15e3,
    maxRedirects: 3,
    auditContext: "tlon-urbit-login"
  });
  try {
    if (!response.ok) {
      throw new UrbitAuthError("auth_failed", `Login failed with status ${response.status}`);
    }
    await response.text().catch(() => {
    });
    const cookie = response.headers.get("set-cookie");
    if (!cookie) {
      throw new UrbitAuthError("missing_cookie", "No authentication cookie received");
    }
    return cookie;
  } finally {
    await release();
  }
}
export {
  authenticate
};
