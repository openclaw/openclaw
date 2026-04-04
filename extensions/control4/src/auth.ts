import https from "node:https";

const C4_APPLICATION_KEY = "78f6791373d61bea49fdb9fb8897f1f3af193f11";
const C4_CLOUD_HOST = "apis.control4.com";

type TokenCache = {
  token: string;
  expiresAt: number;
};

let accountTokenCache: TokenCache | null = null;
let directorTokenCache: TokenCache | null = null;

function httpsRequest(
  method: string,
  host: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const options = {
      host,
      path,
      method,
      rejectUnauthorized: false,
      headers,
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk: Buffer) => (responseData += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseData }));
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    if (data) req.write(data);
    req.end();
  });
}

async function getAccountToken(): Promise<string> {
  const now = Date.now();
  if (accountTokenCache && accountTokenCache.expiresAt > now) {
    return accountTokenCache.token;
  }

  const email = process.env["CONTROL4_EMAIL"];
  const password = process.env["CONTROL4_PASSWORD"];
  if (!email || !password) {
    throw new Error("CONTROL4_EMAIL and CONTROL4_PASSWORD environment variables are required");
  }

  const requestBody = {
    clientInfo: {
      device: {
        deviceName: "openclaw",
        deviceUUID: "0000000000000000",
        make: "openclaw",
        model: "openclaw",
        os: "Android",
        osVersion: "10",
      },
      userInfo: {
        applicationKey: C4_APPLICATION_KEY,
        password,
        userName: email,
      },
    },
  };

  const response = await httpsRequest(
    "POST",
    C4_CLOUD_HOST,
    "/authentication/v1/rest",
    requestBody,
  );

  if (response.status !== 200) {
    throw new Error(`Control4 account auth failed: HTTP ${response.status} — ${response.body}`);
  }

  const parsed = JSON.parse(response.body) as {
    authToken: { token: string; validSeconds: number };
  };
  const token = parsed.authToken.token;
  const validSeconds = parsed.authToken.validSeconds;

  // validSeconds of -1 means it does not expire; we cache for 24h as a safe upper bound
  const ttl = validSeconds > 0 ? validSeconds * 1000 : 86400 * 1000;
  accountTokenCache = { token, expiresAt: now + ttl - 60_000 };
  return token;
}

/** Returns a valid director JWT, refreshing if needed. */
export async function getDirectorToken(): Promise<string> {
  const now = Date.now();
  if (directorTokenCache && directorTokenCache.expiresAt > now) {
    return directorTokenCache.token;
  }

  const controllerName = process.env["CONTROL4_CONTROLLER_NAME"];
  if (!controllerName) {
    throw new Error("CONTROL4_CONTROLLER_NAME environment variable is required");
  }

  const accountToken = await getAccountToken();

  const response = await httpsRequest(
    "POST",
    C4_CLOUD_HOST,
    "/authentication/v1/rest/authorization",
    { serviceInfo: { commonName: controllerName, services: "director" } },
    accountToken,
  );

  if (response.status !== 200) {
    throw new Error(`Control4 director auth failed: HTTP ${response.status} — ${response.body}`);
  }

  const parsed = JSON.parse(response.body) as {
    authToken: { token: string; validSeconds: number };
  };
  const token = parsed.authToken.token;
  const validSeconds = parsed.authToken.validSeconds;

  // Director JWT expires in 86400s — refresh 5 minutes early
  const ttl = validSeconds > 0 ? validSeconds * 1000 : 86400 * 1000;
  directorTokenCache = { token, expiresAt: now + ttl - 300_000 };
  return token;
}

/** Invalidate the cached director token (e.g. after a 401 response). */
export function invalidateDirectorToken(): void {
  directorTokenCache = null;
}
