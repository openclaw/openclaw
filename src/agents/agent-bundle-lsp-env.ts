/** Bundle LSP server environment: allowlisted base plus withheld-name diagnostics. */
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { inspectHostExecEnvOverrides, sanitizeHostExecEnv } from "../infra/host-env-security.js";

export const LSP_ENV_PASSTHROUGH_DOCS_URL =
  "https://docs.openclaw.ai/plugins/bundles#lsp-server-environment";

// Locale, temp, XDG, and toolchain locations language servers read. None is a
// credential. Bundle authors, not operators, write a server's `env`, and the exec
// override policy refuses the XDG and rustup names there, so keep them inherited.
// The host env policy still drops inherited `GOPATH` and `CARGO_HOME`.
const LSP_INHERITED_ENV_KEYS = new Set([
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "GOROOT",
  "GOMODCACHE",
  "GOBIN",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "JAVA_HOME",
]);

// Non-secret Gateway variables language servers commonly need that the base above
// does not carry. Only these names are reported; values are never read for output.
const COMMONLY_NEEDED_LSP_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "PYTHONPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "GOPATH",
  "GOFLAGS",
  "GOPRIVATE",
  "GOPROXY",
  "GONOPROXY",
  "GONOSUMDB",
  "CARGO_HOME",
  "CARGO_TARGET_DIR",
  "GRADLE_USER_HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "DOTNET_ROOT",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
];

const SECRET_LOOKING_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i;

type EnvSource = Record<string, string | undefined>;

function envLookupName(key: string): string {
  // Windows names are case-insensitive; keep the spelling the host used.
  return process.platform === "win32" ? key.toUpperCase() : key;
}

/** Bundle LSP base env: the MCP stdio defaults plus toolchain locations, never Gateway secrets. */
function resolveLspBaseEnv(parentEnv: EnvSource): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [key, value] of Object.entries(parentEnv)) {
    const name = envLookupName(key);
    if (value !== undefined && (name.startsWith("LC_") || LSP_INHERITED_ENV_KEYS.has(name))) {
      env[key] = value;
    }
  }
  return env;
}

/** Child env for a bundle LSP server: allowlisted base, then the server's own `env`. */
export function resolveLspServerEnv(
  serverEnv: Record<string, string> | undefined,
  parentEnv: EnvSource = process.env,
): Record<string, string> {
  return sanitizeHostExecEnv({
    baseEnv: resolveLspBaseEnv(parentEnv),
    overrides: serverEnv ?? null,
  });
}

export type WithheldLspEnvNames = {
  /** Withheld names the server's `env` can supply. */
  configurable: string[];
  /** Withheld names the host exec env policy also refuses in the server's `env`. */
  refused: string[];
};

/** Names of commonly needed, non-secret parent variables missing from a server's child env. */
export function collectWithheldLspEnvNames(params: {
  parentEnv: EnvSource;
  childEnv: Record<string, string>;
}): WithheldLspEnvNames {
  const candidates = new Set(COMMONLY_NEEDED_LSP_ENV_NAMES.map(envLookupName));
  const childNames = new Set(Object.keys(params.childEnv).map(envLookupName));
  const withheld = new Set<string>();
  for (const [key, value] of Object.entries(params.parentEnv)) {
    const name = envLookupName(key);
    if (
      value?.trim() &&
      candidates.has(name) &&
      !childNames.has(name) &&
      !SECRET_LOOKING_ENV_NAME.test(name)
    ) {
      withheld.add(key);
    }
  }
  const result: WithheldLspEnvNames = { configurable: [], refused: [] };
  for (const name of [...withheld].toSorted()) {
    const { rejectedOverrideBlockedKeys } = inspectHostExecEnvOverrides({
      overrides: { [name]: "" },
    });
    (rejectedOverrideBlockedKeys.length > 0 ? result.refused : result.configurable).push(name);
  }
  return result;
}

/** One line per category; empty when nothing commonly needed was withheld. */
export function formatWithheldLspEnvHints(withheld: WithheldLspEnvNames): string[] {
  const lines: string[] = [];
  if (withheld.configurable.length > 0) {
    lines.push(
      `${withheld.configurable.join(", ")}: add to the server's "env" in its bundle .lsp.json if it needs them.`,
    );
  }
  if (withheld.refused.length > 0) {
    lines.push(
      `${withheld.refused.join(", ")}: refused by the host exec env policy, also in "env"; a server that needs them must set them itself (for example, a wrapper script as its "command").`,
    );
  }
  return lines;
}
