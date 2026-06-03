// Environment-variable placeholders for browser actions.
//
// The agent may write `{{env:KEY}}` anywhere it would type a literal value
// (the `type` text, a `fill` field value, a `select` value). Just before the
// keystrokes are dispatched to the browser, the placeholder is replaced with
// the value of the environment variable `KEY`. The substitution happens inside
// the tool, after the agent's tool call has already been recorded — so the
// model context and the transcript only ever contain `{{env:KEY}}`, never the
// secret itself.
//
// Which env vars may be referenced is governed by the native SecretRef "env"
// provider allowlist (`secrets.providers.<env>.allowlist`): resolution goes
// through `resolveSecretRefValues`, which throws when `KEY` is not allowlisted
// or is unset. We fail closed — an unresolved placeholder aborts the action
// rather than typing the literal `{{env:KEY}}` text.

import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/runtime-secret-resolution";
import type { BrowserActRequest } from "./client-actions.types.js";

// KEY follows POSIX-ish env var naming; the allowlist does the real gating.
const ENV_PLACEHOLDER = /\{\{\s*env:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Values resolved from {{env:KEY}} this process, so the browser tool can scrub
// them from its own textual output (snapshots, action results) — a secret that
// was typed into a visible field must not leak back to the model verbatim.
const knownSecretValues = new Set<string>();

/** Mask any previously-resolved env secret value found in `text`. */
export function redactKnownSecrets(text: string): string {
  if (!text || knownSecretValues.size === 0) return text;
  let out = text;
  for (const value of knownSecretValues) {
    if (value) out = out.split(value).join("••••••");
  }
  return out;
}

function collectEnvKeys(value: string, out: Set<string>): void {
  for (const match of value.matchAll(ENV_PLACEHOLDER)) out.add(match[1]);
}

function collectActRequestEnvKeys(request: BrowserActRequest, out: Set<string>): void {
  switch (request.kind) {
    case "type":
      collectEnvKeys(request.text, out);
      break;
    case "fill":
      for (const field of request.fields) {
        if (typeof field.value === "string") collectEnvKeys(field.value, out);
      }
      break;
    case "select":
      for (const value of request.values) collectEnvKeys(value, out);
      break;
    case "batch":
      for (const action of request.actions) collectActRequestEnvKeys(action, out);
      break;
    default:
      break;
  }
}

function substituteActRequest(
  request: BrowserActRequest,
  values: Map<string, string>,
): BrowserActRequest {
  const sub = (value: string): string =>
    value.replace(ENV_PLACEHOLDER, (match, key: string) => values.get(key) ?? match);
  switch (request.kind) {
    case "type":
      return { ...request, text: sub(request.text) };
    case "fill":
      return {
        ...request,
        fields: request.fields.map((field) =>
          typeof field.value === "string" ? { ...field, value: sub(field.value) } : field,
        ),
      };
    case "select":
      return { ...request, values: request.values.map(sub) };
    case "batch":
      return {
        ...request,
        actions: request.actions.map((action) => substituteActRequest(action, values)),
      };
    default:
      return request;
  }
}

async function resolveEnvKeyValue(key: string, config: OpenClawConfig): Promise<string> {
  const provider = resolveDefaultSecretProviderAlias({ secrets: config.secrets }, "env");
  // resolveSecretRefValues enforces secrets.providers.<provider>.allowlist and
  // throws if `key` is not allowlisted or resolves to no value.
  const resolved = await resolveSecretRefValues([{ source: "env", provider, id: key }], {
    config,
  });
  const value = [...resolved.values()][0];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`environment variable "${key}" resolved to an empty or non-string value`);
  }
  return value;
}

/**
 * Replace every `{{env:KEY}}` placeholder in a browser action request with the
 * value of the referenced environment variable. Returns the original request
 * unchanged when it contains no placeholders (no secret resolution attempted).
 *
 * Throws when a referenced variable is not allowlisted or is unset — callers
 * must surface this as a tool error and must NOT dispatch the action.
 */
export async function resolveEnvInActRequest(
  request: BrowserActRequest,
  config: OpenClawConfig,
): Promise<BrowserActRequest> {
  const keys = new Set<string>();
  collectActRequestEnvKeys(request, keys);
  if (keys.size === 0) return request;

  const values = new Map<string, string>();
  for (const key of keys) {
    let value: string;
    try {
      value = await resolveEnvKeyValue(key, config);
    } catch (err) {
      throw new Error(
        `cannot type {{env:${key}}}: ${(err as Error).message}. Add "${key}" to ` +
          `secrets.providers.<env>.allowlist and set it in the environment.`,
        { cause: err },
      );
    }
    values.set(key, value);
    knownSecretValues.add(value);
  }
  return substituteActRequest(request, values);
}

export const __testing = { ENV_PLACEHOLDER, knownSecretValues };
