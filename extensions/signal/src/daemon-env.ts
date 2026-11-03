// Environment owner for the managed signal-cli daemon: what it inherits from the Gateway,
// and which commonly needed variables it no longer inherits.

// signal-cli needs process essentials, its Java launcher inputs, and data-dir hints.
// Everything else in the Gateway environment (provider keys, Gateway and hook tokens,
// secret-manager credentials) stays out of the daemon's long-lived environment.
const SIGNAL_CLI_INHERITED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "JAVA_HOME",
  "JAVA_OPTS",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "SIGNAL_CLI_OPTS",
  // signal-cli reads these itself: the user config file (it can set trustNewIdentities,
  // dataDir and account, and replaces the XDG lookup when set) and the server user agent.
  "SIGNAL_CLI_CONFIG",
  "SIGNAL_CLI_USER_AGENT",
  // Builds without a bundled libsignal_jni for the platform locate it through the loader path.
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
]);
const SIGNAL_CLI_INHERITED_ENV_PREFIXES = ["LC_", "XDG_"];

// Non-secret proxy and trust-store variables that wrapper scripts and native tools commonly
// rely on. They are not inherited, so operators who set them get told by name (never value:
// proxy URLs can embed credentials). This is a fixed list of names, so arbitrary Gateway
// variables, including secret-looking ones, can never appear in the notice.
const SIGNAL_CLI_DROPPED_ENV_HINT_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
]);

const SIGNAL_MANAGED_DAEMON_ENV_DOCS_URL =
  "https://docs.openclaw.ai/channels/signal#managed-daemon-environment";

function isSignalDaemonEnvKeyInherited(name: string): boolean {
  return (
    SIGNAL_CLI_INHERITED_ENV_KEYS.has(name) ||
    SIGNAL_CLI_INHERITED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function buildSignalDaemonEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const retainedWindowsKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") {
      continue;
    }
    // Windows environment names are case-insensitive; POSIX names are exact.
    const name = platform === "win32" ? key.toUpperCase() : key;
    if (!isSignalDaemonEnvKeyInherited(name)) {
      continue;
    }
    if (platform === "win32") {
      const previousKey = retainedWindowsKeys.get(name);
      if (previousKey !== undefined) {
        delete env[previousKey];
      }
      retainedWindowsKeys.set(name, key);
    }
    env[key] = value;
  }
  return env;
}

/** Names (as set, sorted) of commonly needed non-secret variables the daemon does not inherit. */
export function listSignalDaemonDroppedEnvHints(source: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    // Proxy variables are honored in either case by most tools, so match case-insensitively.
    if (
      typeof value === "string" &&
      value.trim() &&
      SIGNAL_CLI_DROPPED_ENV_HINT_KEYS.has(key.toUpperCase())
    ) {
      names.add(key);
    }
  }
  return [...names].toSorted();
}

/** Operator notice naming the dropped variables and the supported ways to supply them. */
export function formatSignalDaemonDroppedEnvNotice(names: readonly string[]): string {
  return (
    `The managed signal-cli daemon does not inherit ${names.join(", ")} from the OpenClaw process environment. ` +
    "signal-cli's JVM takes proxy and trust-store settings from Java system properties: pass them in " +
    "JAVA_TOOL_OPTIONS (for example -Dhttps.proxyHost=<host> -Dhttps.proxyPort=<port>, or " +
    "-Djavax.net.ssl.trustStore=<path> for a private CA), set the variables inside a transport.cliPath " +
    "wrapper script, or run the daemon yourself with transport.kind external-native. " +
    `See ${SIGNAL_MANAGED_DAEMON_ENV_DOCS_URL}`
  );
}
