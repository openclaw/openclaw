import fs from "node:fs";
import path from "node:path";

const BROKER_DEPLOYMENT = "reminiscent-ibex-847";
const BROKER_SITE_URL = `https://${BROKER_DEPLOYMENT}.convex.site`;
const CLI_LOOKUP_TIMEOUT_MS = 15_000;

type QaConvexLauncher = { command: string; prefix: string[]; label: string };
export type QaConvexLookupOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  launcher: QaConvexLauncher;
};
export type QaConvexLookup = (args: string[], options: QaConvexLookupOptions) => Promise<string>;
type QaConvexCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};
export type QaConvexCommandExecutor = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
) => Promise<QaConvexCommandResult>;

const LAUNCHERS: QaConvexLauncher[] = [
  { command: "convex", prefix: [], label: "convex" },
  { command: "bunx", prefix: ["--no-install", "convex"], label: "bunx convex" },
  {
    command: "npx",
    prefix: ["--offline", "--no", "--ignore-scripts", "convex"],
    label: "npx convex",
  },
];

// Preserve CLI login/cache and network routing, not unrelated provider or app credentials.
const CLI_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "NPM_CONFIG_CACHE",
  "npm_config_cache",
  "PNPM_HOME",
  "COREPACK_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** The caller supplies its existing process owner; this module owns discovery and diagnostics. */
export async function runQaConvexLookup(
  args: string[],
  options: QaConvexLookupOptions,
  execute: QaConvexCommandExecutor,
): Promise<string> {
  if (!fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw Object.assign(new Error("The broker project directory is unavailable."), {
      code: "PROJECT_ACCESS",
    });
  }
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
  for (const key of CLI_ENV_KEYS) {
    if (options.env[key] !== undefined) {
      env[key] = options.env[key];
    }
  }
  let result: QaConvexCommandResult;
  try {
    result = await execute(options.launcher.command, [...options.launcher.prefix, ...args], {
      cwd: options.cwd,
      env,
      signal: options.signal,
      timeoutMs: CLI_LOOKUP_TIMEOUT_MS,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    const code = errorCode(error);
    if (code === "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" || code === "CLEANUP_UNCONFIRMED") {
      throw Object.assign(
        new Error(
          "Convex helper cleanup is unconfirmed; settle its owned process before retrying.",
        ),
        { code: "CLEANUP_UNCONFIRMED" },
      );
    }
    throw Object.assign(new Error("Convex launcher failed."), {
      code: code === "ENOENT" || code === "EACCES" ? "UNAVAILABLE" : "LOOKUP_FAILED",
    });
  }
  options.signal?.throwIfAborted();
  if (result.timedOut || result.status !== 0) {
    const diagnostic = `${result.stderr}\n${result.stdout}`;
    const code = result.timedOut
      ? "TIMED_OUT"
      : /not (?:logged|authenticated)|log ?in|authenticate|unauthenticated|401/iu.test(diagnostic)
        ? "AUTH_REQUIRED"
        : /project|deployment|forbidden|permission|403/iu.test(diagnostic)
          ? "PROJECT_ACCESS"
          : /not found|not installed|missing packages|could not determine executable|could not find an existing 'convex' binary to run|ENOTCACHED|ENOENT/iu.test(
                diagnostic,
              )
            ? "UNAVAILABLE"
            : "LOOKUP_FAILED";
    // CLI output may contain the requested secret or private project metadata.
    throw Object.assign(new Error("Convex credential lookup failed."), { code });
  }
  return result.stdout.trim();
}

function parseConnection(siteUrl: string, secret: string, allowInsecureHttp?: string) {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error("OPENCLAW_QA_CONVEX_SITE_URL must be a valid URL.");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      loopback &&
      /^(?:1|true|yes)$/iu.test(allowInsecureHttp?.trim() ?? "")
    )
  ) {
    throw new Error(
      "OPENCLAW_QA_CONVEX_SITE_URL must use https://. Loopback http:// requires OPENCLAW_QA_ALLOW_INSECURE_HTTP=1.",
    );
  }
  return { siteUrl: parsed.toString().replace(/\/+$/u, ""), secret };
}

export async function resolveQaConvexBrokerConnection(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  runConvexCliImpl: QaConvexLookup;
  convexProjectDir?: string;
  signal?: AbortSignal;
}): Promise<{ siteUrl: string; secret: string; source: "env" | "convex-cli" }> {
  const { env, signal } = options;
  const siteUrl = env.OPENCLAW_QA_CONVEX_SITE_URL?.trim();
  const secret = env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  if (siteUrl || secret) {
    if (!siteUrl || !secret) {
      throw new Error(
        "Set both OPENCLAW_QA_CONVEX_SITE_URL and OPENCLAW_QA_CONVEX_SECRET_CI, or leave both unset to use Convex CLI authentication.",
      );
    }
    return {
      ...parseConnection(siteUrl, secret, env.OPENCLAW_QA_ALLOW_INSECURE_HTTP),
      source: "env",
    };
  }
  const cwd = options.convexProjectDir ?? path.join(options.cwd, "qa", "convex-credential-broker");
  const failures: Array<{ launcher: string; code: string }> = [];
  let authenticated = false;
  for (const launcher of LAUNCHERS) {
    signal?.throwIfAborted();
    try {
      const cliSecret = (
        await options.runConvexCliImpl(
          ["env", "--deployment", BROKER_DEPLOYMENT, "get", "OPENCLAW_QA_CONVEX_SECRET_CI"],
          { cwd, env, signal, launcher },
        )
      ).trim();
      signal?.throwIfAborted();
      authenticated = true;
      if (!cliSecret) {
        throw Object.assign(new Error("Broker credential is missing."), { code: "BROKER_CONFIG" });
      }
      return { ...parseConnection(BROKER_SITE_URL, cliSecret), source: "convex-cli" };
    } catch (error) {
      signal?.throwIfAborted();
      const observed = errorCode(error);
      if (observed === "CLEANUP_UNCONFIRMED") {
        throw error;
      }
      const code = [
        "UNAVAILABLE",
        "TIMED_OUT",
        "AUTH_REQUIRED",
        "PROJECT_ACCESS",
        "BROKER_CONFIG",
      ].includes(observed ?? "")
        ? observed!
        : "LOOKUP_FAILED";
      failures.push({ launcher: launcher.label, code });
    }
  }
  const details = failures.map(({ launcher, code }) => `${launcher}: ${code}`).join("; ");
  const remedy = authenticated
    ? "An existing launcher authenticated; check the production broker CI variable, not login."
    : failures.some(({ code }) => code === "PROJECT_ACCESS")
      ? "Check existing Convex access to the broker project before requesting credentials."
      : failures.every(({ code }) => code === "UNAVAILABLE" || code === "AUTH_REQUIRED")
        ? "No existing launcher can authenticate. Ask the user to provide authenticated Convex access or the broker environment pair."
        : "Resolve the reported launcher or connectivity error before concluding credentials are missing.";
  throw new Error(
    `Could not load the QA broker through existing Convex launchers (${details}). ${remedy} No installation or login was attempted.`,
  );
}
