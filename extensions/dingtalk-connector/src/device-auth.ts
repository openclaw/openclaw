import { getRegistrationBaseUrl, getRegistrationSource } from "./device-auth-config.ts";
import { dingtalkHttp } from "./utils/http-client.ts";

type RegistrationApiResponse<T extends Record<string, unknown>> = T & {
  errcode: number;
  errmsg?: string;
};

type InitResponse = RegistrationApiResponse<{
  nonce?: string;
  expires_in?: number;
}>;

type BeginResponse = RegistrationApiResponse<{
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}>;

type PollResponse = RegistrationApiResponse<{
  status?: string;
  client_id?: string;
  client_secret?: string;
  fail_reason?: string;
}>;

export type DingtalkRegistrationBeginResult = {
  deviceCode: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type DingtalkRegistrationPollStatus = "WAITING" | "SUCCESS" | "FAIL" | "EXPIRED" | "UNKNOWN";

function assertApiOk<T extends Record<string, unknown>>(
  data: RegistrationApiResponse<T>,
  action: string,
): RegistrationApiResponse<T> {
  if (!data || data.errcode !== 0) {
    throw new Error(
      `[${action}] ${data?.errmsg || "unknown error"} (errcode=${data?.errcode ?? "N/A"})`,
    );
  }
  return data;
}

export async function beginDingtalkRegistration(): Promise<DingtalkRegistrationBeginResult> {
  const initResp = await dingtalkHttp.post<InitResponse>(
    `${getRegistrationBaseUrl()}/app/registration/init`,
    { source: getRegistrationSource() },
  );
  const initData = assertApiOk(initResp.data, "init");
  const nonce = String(initData.nonce ?? "").trim();
  if (!nonce) {
    throw new Error("[init] missing nonce");
  }

  const beginResp = await dingtalkHttp.post<BeginResponse>(
    `${getRegistrationBaseUrl()}/app/registration/begin`,
    { nonce },
  );
  const beginData = assertApiOk(beginResp.data, "begin");
  const deviceCode = String(beginData.device_code ?? "").trim();
  const verificationUriComplete = String(beginData.verification_uri_complete ?? "").trim();
  const verificationUri = String(beginData.verification_uri ?? "").trim() || undefined;
  const userCode = String(beginData.user_code ?? "").trim() || undefined;
  const expiresInSeconds = Number(beginData.expires_in ?? 7200);
  const intervalSeconds = Number(beginData.interval ?? 3);

  if (!deviceCode) {
    throw new Error("[begin] missing device_code");
  }
  if (!verificationUriComplete) {
    throw new Error("[begin] missing verification_uri_complete");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds:
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 7200,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 5,
  };
}

export async function pollDingtalkRegistration(params: { deviceCode: string }): Promise<{
  status: DingtalkRegistrationPollStatus;
  clientId?: string;
  clientSecret?: string;
  failReason?: string;
}> {
  const pollResp = await dingtalkHttp.post<PollResponse>(
    `${getRegistrationBaseUrl()}/app/registration/poll`,
    { device_code: params.deviceCode },
  );
  const pollData = assertApiOk(pollResp.data, "poll");
  const statusRaw = String(pollData.status ?? "")
    .trim()
    .toUpperCase();
  const status: DingtalkRegistrationPollStatus =
    statusRaw === "WAITING" ||
    statusRaw === "SUCCESS" ||
    statusRaw === "FAIL" ||
    statusRaw === "EXPIRED"
      ? statusRaw
      : "UNKNOWN";

  return {
    status,
    clientId: String(pollData.client_id ?? "").trim() || undefined,
    clientSecret: String(pollData.client_secret ?? "").trim() || undefined,
    failReason: String(pollData.fail_reason ?? "").trim() || undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDingtalkRegistrationSuccess(params: {
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}): Promise<{ clientId: string; clientSecret: string }> {
  const RETRY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes retry window for transient errors
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, params.expiresInSeconds) * 1000;
  const intervalMs = Math.max(1, params.intervalSeconds) * 1000;
  let retryStart = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs);
    let polled;
    try {
      polled = await pollDingtalkRegistration({ deviceCode: params.deviceCode });
    } catch (err) {
      // Network or server error — start retry window
      if (!retryStart) retryStart = Date.now();
      if (Date.now() - retryStart < RETRY_WINDOW_MS) {
        continue;
      }
      throw new Error(
        `poll failed after ${RETRY_WINDOW_MS / 1000}s retries: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (polled.status === "WAITING") {
      retryStart = 0;
      continue;
    }
    if (polled.status === "SUCCESS") {
      if (!polled.clientId || !polled.clientSecret) {
        throw new Error("authorization succeeded but credentials are missing");
      }
      return {
        clientId: polled.clientId,
        clientSecret: polled.clientSecret,
      };
    }
    // FAIL / EXPIRED / UNKNOWN — start retry window instead of immediate exit
    if (!retryStart) retryStart = Date.now();
    if (Date.now() - retryStart < RETRY_WINDOW_MS) {
      continue;
    }
    if (polled.status === "FAIL") {
      throw new Error(polled.failReason || "authorization failed");
    }
    if (polled.status === "EXPIRED") {
      throw new Error("authorization expired, please retry");
    }
    throw new Error("authorization returned unknown status");
  }

  throw new Error("authorization timeout, please retry");
}

export async function renderQrCodeText(content: string): Promise<string | null> {
  try {
    const qrModule = await import("qrcode-terminal");
    const qr =
      (qrModule as { default?: { generate?: Function }; generate?: Function }).default ?? qrModule;
    if (typeof qr?.generate !== "function") {
      return null;
    }

    return await new Promise<string>((resolve) => {
      // Call as a method so `this` binds to the module object;
      // qrcode-terminal reads `this.error` for the error-correct level.
      qr.generate(content, { small: true }, (output: string) => resolve(output));
    });
  } catch {
    return null;
  }
}
