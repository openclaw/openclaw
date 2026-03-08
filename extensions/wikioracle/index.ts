/**
 * index.ts — OpenClaw extension entry point for WikiOracle.
 *
 * Registers WikiOracle as a first-class provider in OpenClaw by spawning
 * `bin/wo` for each query.  This gives OpenClaw access to the full
 * WikiOracle pipeline: truth table RAG, DegreeOfTruth computation,
 * Sensation preprocessing, NanoChat online training, and multi-provider
 * routing — all managed server-side.
 *
 * Three capabilities are registered:
 *
 *   1. **Provider** — WikiOracle appears in OpenClaw's provider list
 *      alongside OpenAI, Anthropic, etc.  Selecting it routes all
 *      messages through the WikiOracle server.
 *
 *   2. **Command** (`/wo <message>`) — Direct CLI access from any
 *      OpenClaw channel.  Bypasses the LLM agent and sends the message
 *      straight to bin/wo.
 *
 *   3. **Tool** (`wikioracle_query`) — Lets OpenClaw agents query
 *      WikiOracle programmatically during agentic runs.
 *
 * Configuration is read from the plugin config block in OpenClaw's
 * config file (see openclaw.plugin.json for the schema).
 *
 * @module
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWoStream } from "./src/stream.js";

// ─────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────

/** Default path to bin/wo, relative to the openclaw/ directory. */
const DEFAULT_WO_PATH = "../bin/wo";

/** Default WikiOracle server URL (local development). */
const DEFAULT_SERVER_URL = "https://127.0.0.1:8888";

/** Default state file for stateless mode. */
const DEFAULT_STATE_FILE = "state.xml";

/** Default timeout for bin/wo in milliseconds (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────
//  Plugin definition
// ─────────────────────────────────────────────────────────────────

const plugin = {
  id: "wikioracle",
  name: "WikiOracle",
  description:
    "WikiOracle provider — routes messages through bin/wo CLI for the " +
    "full pipeline (truth table RAG, DegreeOfTruth, online training)",

  register(api: OpenClawPluginApi) {
    // ── Read plugin config ────────────────────────────────────────
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

    const woPath = (cfg.woPath as string | undefined) ?? DEFAULT_WO_PATH;
    const serverUrl = (cfg.serverUrl as string | undefined) ?? DEFAULT_SERVER_URL;
    const insecure = (cfg.insecure as boolean | undefined) ?? true;
    const stateful = (cfg.stateful as boolean | undefined) ?? true;
    const stateFile = (cfg.stateFile as string | undefined) ?? DEFAULT_STATE_FILE;
    const token = cfg.token as string | undefined;

    // ── Provider registration ─────────────────────────────────────
    //
    // Makes WikiOracle selectable as a provider in OpenClaw's UI and
    // config.  Auth is "custom" because WikiOracle handles its own
    // auth via optional bearer tokens — no OAuth or API key flow
    // is needed on the OpenClaw side.

    api.registerProvider({
      id: "wikioracle",
      label: "WikiOracle",
      docsPath: "/providers/wikioracle",
      aliases: ["wo", "oracle"],
      envVars: [],
      auth: [
        {
          id: "local",
          label: "Local WikiOracle server",
          hint:
            "Connects to a WikiOracle server (local or remote). " +
            "Configure the server URL and optional bearer token " +
            "in the plugin config.",
          kind: "custom" as any,
          run: async () => ({ ok: true as const }),
        },
      ],
    });

    // ── /wo command ───────────────────────────────────────────────
    //
    // Direct CLI-style access from any OpenClaw channel:
    //   /wo What is the capital of France?
    //
    // Sends the message through bin/wo and returns the response
    // verbatim.  Does not go through OpenClaw's agent/LLM layer.

    api.registerCommand({
      name: "wo",
      description:
        "Send a message directly through WikiOracle's bin/wo CLI " +
        "(bypasses the OpenClaw agent)",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const message = ctx.args?.trim() ?? "";
        if (!message) {
          return {
            text:
              "Usage: `/wo <your message>`\n\n" +
              "Sends the message through WikiOracle's full pipeline " +
              "(truth table RAG, DegreeOfTruth, online training) and " +
              "returns the response.",
          };
        }

        try {
          const result = await createWoStream({
            woPath,
            serverUrl,
            insecure,
            stateful,
            stateFile,
            message,
            token,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          return { text: result };
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          api.logger.error?.(`wikioracle: /wo command failed: ${detail}`);
          return { text: `WikiOracle error: ${detail}` };
        }
      },
    });

    // ── wikioracle_query tool ─────────────────────────────────────
    //
    // Registers a tool that OpenClaw agents can invoke during agentic
    // runs.  This lets an agent query WikiOracle for grounded,
    // truth-table-aware responses without the user explicitly using
    // /wo.
    //
    // Tool parameters:
    //   message   (required) — the query to send
    //   provider  (optional) — override the server's default provider
    //   model     (optional) — override the model name
    //
    // The tool is marked optional so that OpenClaw can still start
    // even if bin/wo isn't installed or the server is unreachable.

    api.registerTool(
      (_toolCtx) => ({
        type: "function" as const,
        function: {
          name: "wikioracle_query",
          description:
            "Query WikiOracle — sends a message through the full pipeline " +
            "(truth table RAG, DegreeOfTruth computation, online training) " +
            "and returns the grounded response.",
          parameters: {
            type: "object" as const,
            properties: {
              message: {
                type: "string",
                description: "The message to send to WikiOracle",
              },
              provider: {
                type: "string",
                description: "Provider override (e.g. 'openai', 'anthropic', 'wikioracle')",
              },
              model: {
                type: "string",
                description: "Model name override",
              },
              conversationId: {
                type: "string",
                description: "Conversation ID to append to (for multi-turn context)",
              },
            },
            required: ["message"],
          },
        },
        handler: async (params: Record<string, unknown>) => {
          const result = await createWoStream({
            woPath,
            serverUrl,
            insecure,
            stateful,
            stateFile,
            message: params.message as string,
            provider: params.provider as string | undefined,
            model: params.model as string | undefined,
            conversationId: params.conversationId as string | undefined,
            token,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });

          return {
            content: [{ type: "text" as const, text: result }],
          };
        },
      }),
      { optional: true },
    );

    // ── Done ──────────────────────────────────────────────────────

    api.logger.info(
      "wikioracle: registered provider, /wo command, and wikioracle_query tool " +
        `(server=${serverUrl}, stateful=${stateful})`,
    );
  },
};

export default plugin;
