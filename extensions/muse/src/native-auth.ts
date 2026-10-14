import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { museEnvironment } from "./environment.js";

type MuseNativeAuth = {
  apiKey: string;
  source: string;
  mode: "api-key" | "oauth";
  nativeAuth: { runtime: "muse"; mode: "api-key" | "oauth" };
};

/** Inspect native credential presence without copying its secret into OpenClaw's auth store. */
export async function probeMuseNativeAuth(params: {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<MuseNativeAuth | undefined> {
  params.signal?.throwIfAborted();
  const env = await museEnvironment(undefined, params.env);
  params.signal?.throwIfAborted();
  let mode: "api-key" | "oauth" | undefined;
  try {
    const root =
      env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".config");
    const document: unknown = JSON.parse(
      await fs.readFile(path.join(root, "muse", "auth.json"), "utf8"),
    );
    const credential =
      isRecord(document) && isRecord(document.providers) ? document.providers.meta : undefined;
    if (isRecord(credential)) {
      if (typeof credential.api_key === "string" && credential.api_key.trim()) {
        mode = "api-key";
      } else if (typeof credential.access_token === "string" && credential.access_token.trim()) {
        mode = "oauth";
      }
    }
  } catch {
    params.signal?.throwIfAborted();
  }
  if (!mode && process.platform === "darwin" && env.TBH_CREDENTIAL_BACKEND !== "file") {
    try {
      // Muse owns this item. Omitting -w/-g asks for metadata only, never the password.
      const result = await runUtf8CommandWithTimeout(
        [
          "/usr/bin/security",
          "find-generic-password",
          "-s",
          "ai.meta.dev.credentials",
          "-a",
          "meta",
        ],
        { baseEnv: env, timeoutMs: 3_000, signal: params.signal, killProcessTree: true },
      );
      if (result.termination === "exit" && result.code === 0) {
        mode = "oauth";
      }
    } catch {
      params.signal?.throwIfAborted();
    }
  }
  params.signal?.throwIfAborted();
  return mode
    ? {
        apiKey: "muse-native",
        source: "Muse native login",
        mode,
        nativeAuth: { runtime: "muse", mode },
      }
    : undefined;
}
