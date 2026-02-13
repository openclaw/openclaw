/**
 * ConvosInstance — thin wrapper around the `convos` CLI binary.
 *
 * 1 process = 1 conversation. No pool. No routing. No library imports.
 * All operations shell out to `convos <command> --json`.
 * Streaming uses long-lived child processes with JSONL stdout parsing.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CreateConversationResult, InviteResult } from "./types.js";

const execFileAsync = promisify(execFile);

// ---- Types ----

export interface ConvosInstanceOptions {
  onMessage?: (msg: InboundMessage) => void;
  onJoinAccepted?: (info: { joinerInboxId: string }) => void;
  debug?: boolean;
}

export interface InboundMessage {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
}

// ---- Binary resolution ----

let cachedBinPath: string | undefined;

/** Resolve the `convos` CLI binary from the installed @convos/cli package. */
function resolveConvosBin(): string {
  if (cachedBinPath) {
    return cachedBinPath;
  }

  // Strategy 1: createRequire from this file's URL
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@convos/cli/package.json");
    const binPath = path.join(path.dirname(pkgPath), "bin", "run.js");
    if (existsSync(binPath)) {
      cachedBinPath = binPath;
      return binPath;
    }
  } catch {
    // import.meta.url may not resolve when loaded via jiti
  }

  // Strategy 2: walk up from this file to find extension's node_modules
  // This file lives at extensions/convos/src/sdk-client.ts (or .js)
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const extRoot = path.resolve(thisDir, "..");
    const binPath = path.join(extRoot, "node_modules", "@convos", "cli", "bin", "run.js");
    if (existsSync(binPath)) {
      cachedBinPath = binPath;
      return binPath;
    }
  } catch {
    // fileURLToPath may fail for non-file: URLs
  }

  // Fallback: assume `convos` is on PATH
  cachedBinPath = "convos";
  return "convos";
}

// ---- Constants ----

/** Max number of automatic restarts per child process label (stream, join-requests). */
const MAX_CHILD_RESTARTS = 3;
/** Base delay between restarts (multiplied by attempt number). */
const RESTART_BASE_DELAY_MS = 2000;

// ---- ConvosInstance ----

export class ConvosInstance {
  /** The one conversation this instance is bound to. */
  readonly conversationId: string;
  readonly identityId: string;
  readonly label: string | undefined;

  private env: "production" | "dev";
  private children: ChildProcess[] = [];
  private streamChild: ChildProcess | null = null;
  private running = false;
  private restartCounts = new Map<string, number>();
  private onMessage?: (msg: InboundMessage) => void;
  private onJoinAccepted?: (info: { joinerInboxId: string }) => void;
  private debug: boolean;

  private constructor(params: {
    conversationId: string;
    identityId: string;
    label?: string;
    env: "production" | "dev";
    options?: ConvosInstanceOptions;
  }) {
    this.conversationId = params.conversationId;
    this.identityId = params.identityId;
    this.label = params.label;
    this.env = params.env;
    this.onMessage = params.options?.onMessage;
    this.onJoinAccepted = params.options?.onJoinAccepted;
    this.debug = params.options?.debug ?? false;
  }

  // ---- CLI helpers ----

  /** Run a convos command and return raw stdout. */
  private async exec(args: string[]): Promise<string> {
    const bin = resolveConvosBin();
    const finalArgs = [...args, "--env", this.env];
    if (this.debug) {
      console.log(`[convos] exec: convos ${finalArgs.join(" ")}`);
    }
    const { stdout } = await execFileAsync(
      bin === "convos" ? bin : process.execPath,
      bin === "convos" ? finalArgs : [bin, ...finalArgs],
      { env: { ...process.env, CONVOS_ENV: this.env } },
    );
    return stdout;
  }

  /** Run a convos command with --json and parse the JSON output.
   *  The CLI prints human-readable log lines before the pretty-printed
   *  JSON object, so we find the last top-level JSON block in stdout. */
  private async execJson<T>(args: string[]): Promise<T> {
    const stdout = await this.exec([...args, "--json"]);
    // Find the last { and its matching } to extract the JSON object
    const lastBrace = stdout.lastIndexOf("}");
    if (lastBrace !== -1) {
      // Walk backwards from lastBrace to find the matching opening {
      let depth = 0;
      for (let i = lastBrace; i >= 0; i--) {
        if (stdout[i] === "}") depth++;
        else if (stdout[i] === "{") depth--;
        if (depth === 0) {
          return JSON.parse(stdout.slice(i, lastBrace + 1)) as T;
        }
      }
    }
    // Fallback: try parsing the whole thing (will throw a clear error)
    return JSON.parse(stdout.trim()) as T;
  }

  /** Spawn a long-lived convos command and return the child process. */
  private spawnChild(args: string[]): ChildProcess {
    const bin = resolveConvosBin();
    const finalArgs = [...args, "--env", this.env, "--json"];
    if (this.debug) {
      console.log(`[convos] spawn: convos ${finalArgs.join(" ")}`);
    }
    const child = spawn(
      bin === "convos" ? bin : process.execPath,
      bin === "convos" ? finalArgs : [bin, ...finalArgs],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CONVOS_ENV: this.env },
      },
    );
    this.children.push(child);
    child.on("error", (err) => {
      console.error(`[convos] spawn error: ${String(err)}`);
    });
    return child;
  }

  // ==== Factory Methods ====

  /** Restore from config (gateway restart). No CLI call needed — just construct. */
  static fromExisting(
    conversationId: string,
    identityId: string,
    env: "production" | "dev",
    options?: ConvosInstanceOptions,
    label?: string,
  ): ConvosInstance {
    return new ConvosInstance({ conversationId, identityId, label, env, options });
  }

  /** Create a new conversation via `convos conversations create`. */
  static async create(
    env: "production" | "dev",
    params?: {
      name?: string;
      profileName?: string;
      description?: string;
      imageUrl?: string;
      permissions?: "all-members" | "admin-only";
    },
    options?: ConvosInstanceOptions,
  ): Promise<{ instance: ConvosInstance; result: CreateConversationResult }> {
    const args = ["conversations", "create"];
    if (params?.name) {
      args.push("--name", params.name);
    }
    if (params?.profileName) {
      args.push("--profile-name", params.profileName);
    }
    if (params?.description) {
      args.push("--description", params.description);
    }
    if (params?.imageUrl) {
      args.push("--image-url", params.imageUrl);
    }
    if (params?.permissions) {
      args.push("--permissions", params.permissions);
    }

    // Use a temporary instance to access exec helpers
    const tmp = new ConvosInstance({
      conversationId: "",
      identityId: "",
      env,
      options,
    });
    const data = await tmp.execJson<{
      conversationId: string;
      identityId: string;
      name?: string;
      invite: { slug: string; url: string };
    }>(args);

    const instance = new ConvosInstance({
      conversationId: data.conversationId,
      identityId: data.identityId,
      label: params?.name,
      env,
      options,
    });

    return {
      instance,
      result: {
        conversationId: data.conversationId,
        inviteSlug: data.invite.slug,
        inviteUrl: data.invite.url,
      },
    };
  }

  /** Join a conversation via `convos conversations join`. */
  static async join(
    env: "production" | "dev",
    invite: string,
    params?: { profileName?: string; timeout?: number },
    options?: ConvosInstanceOptions,
  ): Promise<{
    instance: ConvosInstance | null;
    status: "joined" | "waiting_for_acceptance";
    conversationId: string | null;
    identityId: string | null;
  }> {
    const args = ["conversations", "join", invite];
    if (params?.profileName) {
      args.push("--profile-name", params.profileName);
    }
    args.push("--timeout", String(params?.timeout ?? 60));

    const tmp = new ConvosInstance({
      conversationId: "",
      identityId: "",
      env,
      options,
    });
    const data = await tmp.execJson<{
      status: string;
      conversationId?: string;
      identityId: string;
      tag?: string;
      name?: string;
    }>(args);

    if (data.status === "joined" && data.conversationId) {
      const instance = new ConvosInstance({
        conversationId: data.conversationId,
        identityId: data.identityId,
        label: data.name,
        env,
        options,
      });
      return {
        instance,
        status: "joined",
        conversationId: data.conversationId,
        identityId: data.identityId,
      };
    }

    return {
      instance: null,
      status: "waiting_for_acceptance",
      conversationId: null,
      identityId: data.identityId,
    };
  }

  // ==== Lifecycle ====

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.restartCounts.clear();

    this.startStreamChild();
    this.startJoinRequestsChild();

    if (this.debug) {
      console.log(`[convos] Started: ${this.conversationId.slice(0, 12)}...`);
    }
  }

  /** Spawn (or re-spawn) the message stream child process. */
  private startStreamChild(): void {
    const streamChild = this.spawnChild(["conversation", "stream", this.conversationId]);
    this.streamChild = streamChild;
    this.pumpJsonLines(streamChild, "stream", (data) => {
      // Skip empty/non-text content
      const content = typeof data.content === "string" ? data.content : "";
      if (!content.trim()) {
        return;
      }

      const msg: InboundMessage = {
        conversationId: this.conversationId,
        messageId: typeof data.id === "string" ? data.id : "",
        senderId: typeof data.senderInboxId === "string" ? data.senderInboxId : "",
        senderName: "",
        content,
        timestamp: typeof data.sentAt === "string" ? new Date(data.sentAt) : new Date(),
      };
      queueMicrotask(() => {
        try {
          this.onMessage?.(msg);
        } catch (err) {
          if (this.debug) {
            console.error("[convos] onMessage error:", err);
          }
        }
      });
    });
  }

  /** Spawn (or re-spawn) the join-requests watcher child process. */
  private startJoinRequestsChild(): void {
    const joinChild = this.spawnChild([
      "conversations",
      "process-join-requests",
      "--watch",
      "--conversation",
      this.conversationId,
    ]);
    this.pumpJsonLines(joinChild, "join-requests", (data) => {
      if (data.event === "join_request_accepted" && data.joinerInboxId) {
        const joinerInboxId = typeof data.joinerInboxId === "string" ? data.joinerInboxId : "";
        if (this.debug) {
          console.log(`[convos] Join accepted: ${joinerInboxId}`);
        }
        this.onJoinAccepted?.({ joinerInboxId });
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.streamChild = null;
    for (const child of this.children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.children = [];
    if (this.debug) {
      console.log(`[convos] Stopped: ${this.conversationId.slice(0, 12)}...`);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** True when the XMTP message stream child process is alive. */
  isStreaming(): boolean {
    return this.running && this.streamChild !== null && this.streamChild.exitCode === null;
  }

  get envName(): "production" | "dev" {
    return this.env;
  }

  // ==== Operations (all shell out to CLI) ====

  async sendMessage(text: string): Promise<{ success: boolean; messageId?: string }> {
    const data = await this.execJson<{ success: boolean; messageId?: string }>([
      "conversation",
      "send-text",
      this.conversationId,
      "--text",
      text,
    ]);
    return data;
  }

  async react(
    messageId: string,
    emoji: string,
    action: "add" | "remove" = "add",
  ): Promise<{ success: boolean; action: "added" | "removed" }> {
    await this.execJson([
      "conversation",
      "send-reaction",
      this.conversationId,
      messageId,
      action,
      emoji,
    ]);
    return { success: true, action: action === "add" ? "added" : "removed" };
  }

  async getInvite(): Promise<InviteResult> {
    const data = await this.execJson<{ slug: string; url: string }>([
      "conversation",
      "invite",
      this.conversationId,
      "--no-qr",
    ]);
    return { inviteSlug: data.slug };
  }

  async updateProfile(profile: { name?: string; image?: string }): Promise<void> {
    const args = ["conversation", "update-profile", this.conversationId];
    if (profile.name !== undefined) {
      args.push("--name", profile.name);
    }
    if (profile.image !== undefined) {
      args.push("--image", profile.image);
    }
    await this.execJson(args);
  }

  /** Shorthand for updateProfile({ name }). */
  async rename(name: string): Promise<void> {
    await this.updateProfile({ name });
  }

  async lock(): Promise<void> {
    await this.execJson(["conversation", "lock", this.conversationId, "--force"]);
  }

  async unlock(): Promise<void> {
    await this.execJson(["conversation", "lock", this.conversationId, "--unlock", "--force"]);
  }

  async explode(): Promise<void> {
    await this.execJson(["conversation", "explode", this.conversationId, "--force"]);
    await this.stop();
  }

  // ==== Private: JSONL stream parsing ====

  private pumpJsonLines(
    child: ChildProcess,
    label: string,
    handler: (data: Record<string, unknown>) => void,
  ): void {
    if (!child.stdout) {
      return;
    }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        handler(data);
      } catch {
        // Non-JSON line (e.g. human-readable output) — skip
        if (this.debug) {
          console.log(`[convos:${label}] non-JSON: ${line}`);
        }
      }
    });

    child.on("exit", (code) => {
      // Remove from children list
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
      }
      if (child === this.streamChild) {
        this.streamChild = null;
      }

      if (this.running) {
        // Unexpected exit — log always (not just in debug mode)
        console.error(`[convos:${label}] exited unexpectedly with code ${code}`);

        // Auto-restart stream/join-requests children after a delay
        const attempt = (this.restartCounts.get(label) ?? 0) + 1;
        if (attempt <= MAX_CHILD_RESTARTS) {
          this.restartCounts.set(label, attempt);
          const delayMs = RESTART_BASE_DELAY_MS * attempt;
          console.error(
            `[convos:${label}] restarting in ${delayMs}ms (attempt ${attempt}/${MAX_CHILD_RESTARTS})`,
          );
          setTimeout(() => {
            if (!this.running) {
              return;
            }
            if (label === "stream") {
              this.startStreamChild();
            } else if (label === "join-requests") {
              this.startJoinRequestsChild();
            }
          }, delayMs);
        } else {
          console.error(
            `[convos:${label}] max restarts reached (${MAX_CHILD_RESTARTS}), giving up`,
          );
          // If all children are gone, mark instance as no longer running
          if (this.children.length === 0) {
            this.running = false;
            console.error("[convos] All child processes exited — instance stopped");
          }
        }
      }
    });

    if (child.stderr) {
      const errRl = createInterface({ input: child.stderr });
      errRl.on("line", (line) => {
        // Always log stderr for diagnostics (crash messages, XMTP errors)
        console.error(`[convos:${label}:stderr] ${line}`);
      });
    }
  }
}
