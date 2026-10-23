import net from "node:net";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  acquireDebugProxyCaptureStoreAsync,
  type AsyncDebugProxyCaptureStore,
  type CaptureQueryPreset,
} from "openclaw/plugin-sdk/proxy-capture";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  asNullableObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseQaJson } from "./json.js";

export function createQaCaptureLifecycle() {
  const captureEnv = {
    OPENCLAW_STATE_DIR: resolveStateDir(),
    OPENCLAW_SUPERVISOR_MODE: process.env.OPENCLAW_SUPERVISOR_MODE,
  };
  let captureStoreLease: ReturnType<typeof acquireDebugProxyCaptureStoreAsync> | undefined;
  let captureClosing = false;
  const captureOperations = new Set<Promise<unknown>>();
  const withCaptureStore = <T>(operation: (store: AsyncDebugProxyCaptureStore) => Promise<T>) => {
    if (captureClosing) {
      return Promise.reject(new Error("Capture store is closing."));
    }
    if (!captureStoreLease) {
      const lease = acquireDebugProxyCaptureStoreAsync({ env: captureEnv });
      captureStoreLease = lease;
      void lease.catch(() => {
        // A failed acquisition owns no store; a later request can acquire again.
        captureStoreLease = undefined;
      });
    }
    const pending = captureStoreLease.then(({ store }) => operation(store));
    captureOperations.add(pending);
    void pending.then(
      () => captureOperations.delete(pending),
      () => captureOperations.delete(pending),
    );
    return pending;
  };

  const releaseCaptureStore = async () => {
    await Promise.allSettled(captureOperations);
    await (await captureStoreLease)?.release();
    captureStoreLease = undefined;
  };
  return {
    withStore: withCaptureStore,
    stopAdmission() {
      captureClosing = true;
    },
    release: releaseCaptureStore,
  };
}

const CAPTURE_QUERY_PRESETS = new Set([
  "double-sends",
  "retry-storms",
  "cache-busting",
  "ws-duplicate-frames",
  "missing-ack",
  "error-bursts",
]);

type QaStartupProbeStatus = {
  url: string;
  ok: boolean;
  error?: string;
};

export function isCaptureQueryPreset(value: string): value is CaptureQueryPreset {
  return CAPTURE_QUERY_PRESETS.has(value);
}

function parseCaptureMeta(metaJson: unknown): Record<string, unknown> | null {
  return typeof metaJson === "string" ? asNullableObjectRecord(safeParseQaJson(metaJson)) : null;
}

export function mapCaptureEventForQa(row: Record<string, unknown>) {
  const meta = parseCaptureMeta(row.metaJson);
  return {
    ...row,
    payloadPreview: typeof row.dataText === "string" ? row.dataText : undefined,
    provider: normalizeOptionalString(meta?.provider),
    api: normalizeOptionalString(meta?.api),
    model: normalizeOptionalString(meta?.model),
    captureOrigin: normalizeOptionalString(meta?.captureOrigin),
  };
}

function defaultPortForProtocol(protocol: string): number {
  if (protocol === "https:") {
    return 443;
  }
  if (protocol === "http:") {
    return 80;
  }
  return 0;
}

async function probeTcpReachability(rawUrl: string): Promise<QaStartupProbeStatus> {
  const parsed = URL.parse(rawUrl);
  if (!parsed) {
    return {
      url: rawUrl,
      ok: false,
      error: "invalid url",
    };
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return {
      url: parsed.toString(),
      ok: false,
      error: "missing host or port",
    };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(700);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", onError);
      socket.once("timeout", () => onError(new Error("timeout")));
    });
    return {
      url: parsed.toString(),
      ok: true,
    };
  } catch (error) {
    return {
      url: parsed.toString(),
      ok: false,
      error: formatErrorMessage(error),
    };
  }
}

export async function readQaCaptureStartupStatus(params: {
  proxyUrl?: string;
  gatewayUrl?: string | null;
  publicBaseUrl: string;
}) {
  const [proxy, gateway] = await Promise.all([
    probeTcpReachability(params.proxyUrl || "http://127.0.0.1:7799"),
    probeTcpReachability(params.gatewayUrl || "http://127.0.0.1:18789/"),
  ]);
  return {
    proxy: { ...proxy, label: "Proxy" },
    gateway: { ...gateway, label: "Gateway" },
    qaLab: { label: "QA Lab", url: params.publicBaseUrl, ok: true },
  };
}
