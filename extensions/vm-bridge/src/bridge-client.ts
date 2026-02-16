/**
 * HTTP client for the VM-Chrome bridge server at :8585.
 * Proxies MCP tool calls and checks bridge health.
 */

export type BridgeConfig = {
  url: string;
};

export type McpCallResult = {
  success: boolean;
  result?: unknown;
  error?: string;
};

export class BridgeClient {
  private url: string;

  constructor(config: BridgeConfig) {
    this.url = config.url.replace(/\/$/, "");
  }

  /** Call an MCP tool through the bridge proxy. */
  async mcpCall(toolName: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const resp = await fetch(`${this.url}/mcp/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: toolName, arguments: args }),
      signal: AbortSignal.timeout(60_000),
    });
    return (await resp.json()) as McpCallResult;
  }

  /** Check bridge server health. */
  async health(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const resp = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json();
      return { ok: resp.ok, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** List connected MCP servers. */
  async servers(): Promise<Record<string, unknown>> {
    const resp = await fetch(`${this.url}/mcp/servers`, {
      signal: AbortSignal.timeout(10_000),
    });
    return (await resp.json()) as Record<string, unknown>;
  }

  // --- Convenience wrappers for common MCP tools ---

  async ingestEmails(account: string, days = 1, maxEmails = 20) {
    return this.mcpCall("ingest_emails", { account, days, max_emails: maxEmails });
  }

  async messagesList(platform: string, days = 1, limit = 50, account?: string) {
    return this.mcpCall("messages_list", { platform, days, limit, ...(account ? { account } : {}) });
  }

  async messagesGet(messageId: string, account: string, platform: string) {
    return this.mcpCall("messages_get", { message_id: messageId, account, platform });
  }

  async messagesSend(to: string, message: string, platform: string, isChannel = false) {
    return this.mcpCall("messages_send", { to, message, platform, is_channel: isChannel });
  }

  async confirmSend(pendingId: string) {
    return this.mcpCall("confirm_send", { pending_id: pendingId });
  }

  async createReplyDraft(emailId: string, body: string, account = "xcellerate") {
    return this.mcpCall("create_reply_draft", { email_id: emailId, body, account });
  }

  async sendDraft(draftId: string, account = "xcellerate") {
    return this.mcpCall("send_draft", { draft_id: draftId, account });
  }

  async createEmailDraft(to: string, subject: string, body: string, account = "xcellerate") {
    return this.mcpCall("create_email_draft", { to, subject, body, account });
  }

  async readAttachment(fileId: string) {
    return this.mcpCall("read_attachment", { file_id: fileId });
  }

  async rolesList() {
    return this.mcpCall("roles_list", {});
  }

  async enrichmentsGet(platform: string, messageId: string) {
    return this.mcpCall("enrichments_get", { platform, message_id: messageId });
  }

  async addAttachmentToDraft(draftId: string, filePath: string, account = "xcellerate") {
    return this.mcpCall("add_attachment_to_draft", { draft_id: draftId, file_path: filePath, account });
  }

  /** Execute a prompt via Claude CLI on the bridge (supports chrome and non-chrome modes). */
  async task(prompt: string, options: { chrome?: boolean; profile?: string; systemPrompt?: string; timeout?: number } = {}): Promise<McpCallResult> {
    try {
      const resp = await fetch(`${this.url}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          chrome: options.chrome ?? false,
          profile: options.profile,
          system_prompt: options.systemPrompt,
          timeout: options.timeout ?? 300,
        }),
        signal: AbortSignal.timeout((options.timeout ?? 300) * 1000 + 10_000),
      });
      const data = await resp.json() as { result: string; status: string; is_error?: boolean };
      return {
        success: data.status === "success" && !data.is_error,
        result: data.result,
        error: data.is_error ? data.result : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Capture a Chrome tab screenshot via CDP and save to disk. */
  async screenshot(savePath: string, profile = "default", url?: string): Promise<McpCallResult> {
    try {
      const resp = await fetch(`${this.url}/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save_path: savePath, profile, ...(url ? { url } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      return (await resp.json()) as McpCallResult;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
