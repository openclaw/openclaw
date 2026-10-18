import { writeFile } from "node:fs/promises";
import type { DecisionProviderV2, ProviderDecisionOutcomeV2 } from "openclaw/plugin-sdk/decisions";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { fromWire, toWire } from "./codec.js";
import { runCli } from "./transport.js";

const CLI_AUTH_MARKER = "cloudflare-cli";

function cliEnvironment(accountId: unknown): NodeJS.ProcessEnv {
  // Keep OS/config lookup, not Gateway credentials, NODE_OPTIONS or Cloudflare
  // token overrides that could silently replace the intended CLI OAuth identity.
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => allowed.has(key) || /^LC_[A-Z_]+$/.test(key)),
    ),
    CI: "true",
    NO_COLOR: "1",
    ...(typeof accountId === "string" ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  };
}

const unavailable = (
  reason: Extract<ProviderDecisionOutcomeV2, { status: "unavailable" }>["reason"],
): ProviderDecisionOutcomeV2 => ({ status: "unavailable", reason });

export function createDecisionProvider(): DecisionProviderV2 {
  return {
    id: "cloudflare-clef",
    contractVersion: 2,
    provider: {
      label: "Cloudflare Clef",
      auth: [],
      authScope: "plugin",
      // The CLI owns and refreshes OAuth. This is an availability marker, not
      // a Cloudflare credential, and is never sent to the CLI or a server.
      resolveSyntheticAuth: () => ({
        apiKey: CLI_AUTH_MARKER,
        source: "Cloudflare CLI",
        mode: "api-key",
      }),
    },
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      if (
        (context.reasoning !== undefined && context.reasoning !== "auto") ||
        context.auth.apiKey !== CLI_AUTH_MARKER ||
        context.auth.profileId !== undefined ||
        context.model.baseUrl ||
        context.model.headers ||
        context.config.models?.providers?.["cloudflare-clef"]?.request
      ) {
        // Never silently replace a host-selected credential/profile with the
        // CLI's identity. CLI transport also cannot honor HTTP request overrides.
        return unavailable("unsupported-input");
      }
      const wire = toWire(batch, context.model.id);
      if (!wire) {
        return unavailable("unsupported-input");
      }
      const config =
        asOptionalRecord(context.config.plugins?.entries?.["cloudflare-clef"]?.config) ?? {};
      const workspace = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-clef-",
      });
      try {
        const body = workspace.path("request.json");
        await writeFile(body, JSON.stringify(wire), { mode: 0o600, flag: "wx" });
        const args = ["ai", "run", `@cf/cloudflare/${context.model.id}`, "--body", `@${body}`];
        if (typeof config.profile === "string") {
          args.push("--profile", config.profile);
        }
        const remaining = context.deadlineMonotonicMs - performance.now();
        context.signal.throwIfAborted();
        if (remaining <= 0) {
          return unavailable("transport");
        }
        if (!context.isAdmissible()) {
          throw new Error("Clef evaluation authority closed");
        }
        // No awaits between the host's live authority check and physical dispatch.
        const command = runCli(
          typeof config.binaryPath === "string" ? config.binaryPath : "cf",
          args,
          {
            cwd: workspace.dir,
            signal: context.signal,
            timeoutMs: Math.max(1, Math.min(30000, remaining)),
            env: cliEnvironment(config.accountId),
          },
        );
        let response;
        try {
          response = await command;
        } catch {
          context.signal.throwIfAborted();
          return unavailable("transport");
        }
        context.signal.throwIfAborted();
        if (response.stopped) {
          return unavailable("transport");
        }
        if (response.code !== 0) {
          // CLI diagnostics can contain evidence. Classify locally, never expose them.
          const error = response.stderr + response.stdout;
          if (/not logged in|not authenticated|login required|cf auth login/i.test(error)) {
            return unavailable("credentials-unavailable");
          }
          if (/401|403|authentication|unauthorized|forbidden/i.test(error)) {
            return unavailable("authentication");
          }
          if (/429|rate.limit/i.test(error)) {
            return unavailable("rate-limited");
          }
          if (/400|413|422|invalid input|context length/i.test(error)) {
            return unavailable("unsupported-input");
          }
          return unavailable("transport");
        }
        try {
          const result = fromWire(JSON.parse(response.stdout), batch, context.model.id);
          return result ? { status: "ok", result } : unavailable("invalid-response");
        } catch {
          return unavailable("invalid-response");
        }
      } finally {
        await workspace.cleanup();
      }
    },
  };
}
