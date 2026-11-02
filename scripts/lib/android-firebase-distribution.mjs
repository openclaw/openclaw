import { createHash, createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch } from "undici";

const API = "https://firebaseappdistribution.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUDIENCES = ["wear", "phone"];
const STATES = new Set([
  "pending",
  "uploaded",
  "notes-updated",
  "distribution-pending",
  "distributed",
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function saveReceipt(file, receipt) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flush: true,
  });
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "TIMEOUT",
]);
const DIAGNOSTIC_CODES = new Set([
  ...TRANSIENT_CODES,
  "ENOTFOUND",
  "UND_ERR_INVALID_ARG",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

function transportCode(error) {
  const code = error?.cause?.code ?? error?.code;
  if (DIAGNOSTIC_CODES.has(code)) {
    return code;
  }
  if (error?.name === "TimeoutError") {
    return "TIMEOUT";
  }
  return error instanceof SyntaxError ? "INVALID_JSON" : "REQUEST_FAILED";
}

async function withConnections(operation) {
  const dispatcher = new Agent();
  try {
    return await operation(dispatcher);
  } finally {
    // Do not carry idle sockets across the coordinator's synchronous Android build.
    await dispatcher.close();
  }
}

async function request(url, options, label, retrySafe = false) {
  const attempts = retrySafe ? 4 : 1;
  const deadline = Date.now() + (retrySafe ? 120_000 : 10 * 60_000);
  for (let attempt = 1; ; attempt++) {
    let status;
    let reason;
    let transient = false;
    let retryAfter = 0;
    try {
      const response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(retrySafe ? 30_000 : 10 * 60_000, deadline - Date.now())),
        ),
      });
      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      }
      status = response.status;
      reason = `HTTP ${status}`;
      transient = TRANSIENT_STATUS.has(status);
      const header = response.headers.get("retry-after");
      if (header) {
        retryAfter = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        if (!Number.isFinite(retryAfter)) {
          retryAfter = 0;
        }
      }
      // Discard private provider bodies and release the connection before retry/close.
      await response.body?.cancel();
    } catch (error) {
      if (!status) {
        reason = transportCode(error);
        transient = TRANSIENT_CODES.has(reason);
      }
    }
    const failure = new Error(
      `Firebase ${label} failed (${reason}; attempt ${attempt}/${attempts}).${!retrySafe && (!status || status >= 500) ? " Its outcome may be uncertain." : ""}`,
    );
    failure.status = status;
    const wait = Math.max(
      retryAfter,
      Math.floor(1000 * 2 ** (attempt - 1) * (0.5 + Math.random())),
    );
    if (!retrySafe || !transient || attempt === attempts || Date.now() + wait >= deadline) {
      throw failure;
    }
    console.warn(
      `Firebase ${label}: ${reason}; retrying attempt ${attempt + 1}/${attempts} in ${wait} ms.`,
    );
    await delay(wait);
    if (Date.now() >= deadline) {
      throw failure;
    }
  }
}

export function createAndroidFirebaseDistribution({ env = process.env } = {}) {
  const appId = env.FIREBASE_APP_ID?.trim();
  const projectNumber = /^1:(\d+):android:[a-f0-9]+$/.exec(appId ?? "")?.[1];
  const groupAliases = [
    ...new Set(
      (env.FIREBASE_TESTER_GROUPS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  if (
    !projectNumber ||
    !groupAliases.length ||
    groupAliases.some((alias) => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(alias))
  ) {
    throw new Error(
      "Set FIREBASE_APP_ID to the Android Firebase app ID and FIREBASE_TESTER_GROUPS to its comma-separated group aliases.",
    );
  }
  let credential;
  let privateKey;
  try {
    credential = JSON.parse(env.FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA ?? "");
    if (
      credential.type !== "service_account" ||
      !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(credential.client_email)
    ) {
      throw new Error();
    }
    privateKey = createPrivateKey(credential.private_key);
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error();
    }
  } catch {
    throw new Error(
      "FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA must contain a valid service-account JSON key.",
    );
  }
  const configuration = Object.freeze({ appId, groupAliases: Object.freeze(groupAliases) });
  const appName = `projects/${projectNumber}/apps/${appId}`;
  let accessToken;
  let tokenExpiresAt = 0;

  async function token(dispatcher) {
    if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
      return accessToken;
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credential.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 })}`;
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    const result = await request(
      TOKEN_URL,
      {
        method: "POST",
        dispatcher,
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      },
      "authentication",
      true,
    );
    if (
      typeof result.access_token !== "string" ||
      !result.access_token ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0
    ) {
      throw new Error("Firebase authentication did not return an access token and expiry.");
    }
    accessToken = result.access_token;
    tokenExpiresAt = Date.now() + result.expires_in * 1000;
    return accessToken;
  }

  async function api(dispatcher, resource, options = {}, label = "request") {
    return request(
      `${API}${resource}`,
      {
        ...options,
        dispatcher,
        headers: {
          Authorization: `Bearer ${await token(dispatcher)}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      label,
      !options.method || options.method === "GET",
    );
  }

  function releaseIdentity(release, artifact) {
    const prefix = `${appName}/releases/`;
    if (
      typeof release?.name !== "string" ||
      !release.name.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]+$/.test(release.name.slice(prefix.length)) ||
      release.displayVersion !== artifact.version ||
      release.buildVersion !== artifact.buildVersion ||
      typeof release.createTime !== "string" ||
      !Number.isFinite(Date.parse(release.createTime))
    ) {
      throw new Error("Firebase release identity differs from the retained Android artifact.");
    }
    return {
      name: release.name,
      displayVersion: release.displayVersion,
      buildVersion: release.buildVersion,
      createTime: release.createTime,
    };
  }

  function operationName(value) {
    const prefix = `${appName}/releases/`;
    if (
      typeof value !== "string" ||
      !value.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]+\/operations\/[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))
    ) {
      throw new Error("Firebase upload returned an invalid operation identity.");
    }
    return value;
  }

  async function preflight(dispatcher) {
    const info = await api(dispatcher, `/v1/${appName}/aabInfo`, {}, "AAB preflight");
    if (info.integrationState !== "INTEGRATED") {
      const state = /^[A-Z_]+$/.test(info.integrationState ?? "")
        ? info.integrationState
        : "unknown";
      throw new Error(
        `Firebase AAB integration is ${state}. Complete Google Play linking and register its Internal App Sharing certificate before publishing.`,
      );
    }
    for (const alias of groupAliases) {
      const name = `projects/${projectNumber}/groups/${alias}`;
      const group = await api(dispatcher, `/v1/${name}`, {}, "tester-group preflight");
      if (group.name !== name) {
        throw new Error("Firebase tester-group identity does not match configuration.");
      }
    }
    return configuration;
  }

  async function distribute(dispatcher, { plan, notes, artifactsDirectory, receiptPath, playRef }) {
    if (
      plan.destination !== "internal" ||
      canonical(plan.firebase) !== canonical(configuration) ||
      !/^20\d{2}\.\d+\.\d+$/.test(plan.version) ||
      !/^[a-f0-9]{40}$/.test(plan.sourceSha) ||
      !Number.isSafeInteger(plan.versionCode) ||
      !Number.isSafeInteger(plan.wearVersionCode) ||
      plan.wearVersionCode <= plan.versionCode ||
      typeof playRef !== "string" ||
      !playRef.startsWith("refs/openclaw/mobile-releases/android/")
    ) {
      throw new Error(
        "Firebase distribution requires the saved internal Android plan and its verified Play upload ref.",
      );
    }
    if (
      notes.platform !== "android" ||
      notes.sourceSha !== plan.sourceSha ||
      notes.version !== plan.version ||
      notes.build !== String(plan.versionCode) ||
      notes.entries?.length !== 2
    ) {
      throw new Error("Firebase release notes do not match the saved Android plan.");
    }
    const artifacts = Object.fromEntries(
      AUDIENCES.map((audience) => {
        const entry = notes.entries.find((candidate) => candidate.audience === audience);
        if (
          typeof entry?.text !== "string" ||
          !entry.text.trim() ||
          entry.textSha256 !== hash(entry.text)
        ) {
          throw new Error(
            `Firebase ${audience} release notes are missing or their digest changed.`,
          );
        }
        const file = `openclaw-${plan.version}-${audience === "phone" ? "play" : "wear"}-release.aab`;
        const filename = path.join(artifactsDirectory, file);
        if (!fs.lstatSync(filename).isFile()) {
          throw new Error(`Retained ${audience} AAB must be a regular file.`);
        }
        const bytes = fs.readFileSync(filename);
        const sha256 = hash(bytes);
        if (fs.readFileSync(`${filename}.sha256`, "utf8").trim() !== `${sha256}  ${file}`) {
          throw new Error(`Retained ${audience} AAB does not match its SHA-256 sidecar.`);
        }
        return [
          audience,
          {
            file,
            bytes,
            sha256,
            version: plan.version,
            buildVersion: String(audience === "phone" ? plan.versionCode : plan.wearVersionCode),
            releaseNotes: `${audience === "phone" ? "Phone" : "Wear OS — watch only"}\n\n${entry.text}`,
          },
        ];
      }),
    );
    const binding = {
      ...configuration,
      sourceSha: plan.sourceSha,
      playRef,
      planSha256: hash(canonical(plan)),
      notesSha256: hash(canonical(notes)),
      artifacts: Object.fromEntries(
        AUDIENCES.map((audience) => {
          const { file, sha256, version, buildVersion } = artifacts[audience];
          return [audience, { file, sha256, version, buildVersion }];
        }),
      ),
    };
    const lock = `${receiptPath}.lock`;
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      throw new Error(
        `Firebase distribution is locked at ${lock}. Check the recorded process before removing a stale lock.`,
        { cause: error },
      );
    }
    try {
      const receipt = fs.existsSync(receiptPath)
        ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
        : {
            schemaVersion: 1,
            binding,
            releases: { wear: { state: "pending" }, phone: { state: "pending" } },
          };
      if (
        receipt.schemaVersion !== 1 ||
        canonical(receipt.binding) !== canonical(binding) ||
        Object.keys(receipt.releases ?? {})
          .toSorted((left, right) => left.localeCompare(right))
          .join(",") !== "phone,wear"
      ) {
        throw new Error(
          "Firebase receipt does not match this plan, notes, configuration, Play ref, and signed artifacts.",
        );
      }
      for (const audience of AUDIENCES) {
        const saved = receipt.releases[audience];
        if (!STATES.has(saved?.state)) {
          throw new Error("Firebase receipt has an invalid distribution state.");
        }
        if (saved.operation) {
          operationName(saved.operation);
        }
        if (saved.state !== "pending") {
          releaseIdentity(saved.release, artifacts[audience]);
        }
        if (saved.state === "distribution-pending") {
          throw new Error(
            `Firebase ${audience} notification outcome is uncertain for ${saved.release.name}. Inspect Firebase before reconciliation; this command will not resend emails.`,
          );
        }
      }
      if (
        receipt.releases.phone.state !== "pending" &&
        receipt.releases.wear.state !== "distributed"
      ) {
        throw new Error("Firebase receipt violates Wear-before-Phone distribution order.");
      }
      saveReceipt(receiptPath, receipt);
      await preflight(dispatcher);
      // Firebase sorts by release creation time: finish Wear before creating Phone.
      for (const audience of AUDIENCES) {
        const saved = receipt.releases[audience];
        const artifact = artifacts[audience];
        if (saved.state === "distributed") {
          continue;
        }
        if (saved.state === "pending") {
          if (!saved.operation) {
            // Re-uploading these exact bytes is deduplicated and does not send tester emails.
            const upload = await api(
              dispatcher,
              `/upload/v1/${appName}/releases:upload`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "X-Goog-Upload-Protocol": "raw",
                  "X-Goog-Upload-File-Name": encodeURIComponent(artifact.file),
                },
                body: artifact.bytes,
              },
              `${audience} upload`,
            );
            saved.operation = operationName(upload.name);
            saveReceipt(receiptPath, receipt);
          }
          const deadline = Date.now() + 5 * 60_000;
          while (true) {
            const operation = await api(
              dispatcher,
              `/v1/${saved.operation}`,
              {},
              `${audience} upload status`,
            );
            if (operation.done) {
              if (operation.error) {
                delete saved.operation;
                saveReceipt(receiptPath, receipt);
                throw new Error(
                  `Firebase ${audience} upload processing failed. Inspect the Firebase console before retrying its retained artifact.`,
                );
              }
              saved.release = releaseIdentity(operation.response?.release, artifact);
              saved.state = "uploaded";
              saveReceipt(receiptPath, receipt);
              break;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                `Firebase ${audience} upload is still processing; resume with the saved recovery directory.`,
              );
            }
            await delay(5000);
          }
        }
        if (saved.state === "uploaded") {
          await api(
            dispatcher,
            `/v1/${saved.release.name}?updateMask=release_notes.text`,
            {
              method: "PATCH",
              body: JSON.stringify({
                name: saved.release.name,
                releaseNotes: { text: artifact.releaseNotes },
              }),
            },
            `${audience} release notes`,
          );
          saved.state = "notes-updated";
          saveReceipt(receiptPath, receipt);
        }
        // Persist intent before the non-idempotent email request. Missing acknowledgment stays fenced.
        saved.state = "distribution-pending";
        saveReceipt(receiptPath, receipt);
        try {
          await api(
            dispatcher,
            `/v1/${saved.release.name}:distribute`,
            {
              method: "POST",
              body: JSON.stringify({ groupAliases }),
            },
            `${audience} distribution`,
          );
        } catch (error) {
          if ([400, 401, 403, 404, 412, 429].includes(error.status)) {
            saved.state = "notes-updated";
            saveReceipt(receiptPath, receipt);
          }
          throw error;
        }
        saved.state = "distributed";
        saveReceipt(receiptPath, receipt);
      }
      return receipt;
    } finally {
      fs.unlinkSync(lock);
    }
  }

  return {
    configuration,
    preflight: () => withConnections(preflight),
    distribute: (options) => withConnections((dispatcher) => distribute(dispatcher, options)),
  };
}
