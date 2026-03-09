/**
 * HTTP client for the InboxAPI MCP endpoint.
 * Wraps MCP tool calls as JSON-RPC requests.
 */

import type { InboxApiEmail, InboxApiWhoAmI } from "./types.js";

export interface InboxApiClientOptions {
  mcpEndpoint: string;
  accessToken: string;
  fromName?: string;
}

interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Call an MCP tool on the InboxAPI server.
 */
async function callMcpTool(
  opts: InboxApiClientOptions,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<McpToolCallResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const res = await fetch(opts.mcpEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.accessToken}`,
    },
    body,
  });

  if (res.status === 429) {
    // Rate limited — back off and retry once
    await sleep(2000);
    const retry = await fetch(opts.mcpEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body,
    });
    if (!retry.ok) {
      throw new Error(`InboxAPI MCP call failed: ${retry.status} ${retry.statusText}`);
    }
    const retryData = await retry.json();
    return retryData.result ?? {};
  }

  if (!res.ok) {
    throw new Error(`InboxAPI MCP call failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.result ?? {};
}

/** Extract text content from MCP tool result */
function extractText(result: McpToolCallResult): string {
  if (result.isError) {
    const errText = result.content?.find((c) => c.type === "text")?.text;
    throw new Error(`InboxAPI error: ${errText ?? "unknown error"}`);
  }
  return result.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Parse JSON from MCP text result */
function parseJsonResult<T>(result: McpToolCallResult): T {
  const text = extractText(result);
  return JSON.parse(text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Public API ---

/** Get the agent's identity (account name, email, domain) */
export async function whoami(opts: InboxApiClientOptions): Promise<InboxApiWhoAmI> {
  const result = await callMcpTool(opts, "whoami");
  return parseJsonResult<InboxApiWhoAmI>(result);
}

/** Get the total email count, optionally filtered by since timestamp */
export async function getEmailCount(opts: InboxApiClientOptions, since?: string): Promise<number> {
  const args: Record<string, unknown> = {};
  if (since) args.since = since;
  const result = await callMcpTool(opts, "get_email_count", args);
  const text = extractText(result);
  // Response is typically a number or JSON with count
  const parsed = JSON.parse(text);
  return typeof parsed === "number" ? parsed : (parsed.count ?? 0);
}

/** Get emails, optionally filtered */
export async function getEmails(
  opts: InboxApiClientOptions,
  params?: { limit?: number; since?: string },
): Promise<InboxApiEmail[]> {
  const args: Record<string, unknown> = {};
  if (params?.limit) args.limit = params.limit;
  if (params?.since) args.since = params.since;
  const result = await callMcpTool(opts, "get_emails", args);
  return parseJsonResult<InboxApiEmail[]>(result);
}

/** Get the most recent email */
export async function getLastEmail(opts: InboxApiClientOptions): Promise<InboxApiEmail | null> {
  const result = await callMcpTool(opts, "get_last_email");
  const text = extractText(result);
  if (!text || text === "null" || text === "No emails found") return null;
  return JSON.parse(text) as InboxApiEmail;
}

/** Get a specific email by ID */
export async function getEmail(
  opts: InboxApiClientOptions,
  emailId: string,
): Promise<InboxApiEmail | null> {
  const result = await callMcpTool(opts, "get_email", { email_id: emailId });
  const text = extractText(result);
  if (!text || text === "null") return null;
  return JSON.parse(text) as InboxApiEmail;
}

/** Get a full email thread */
export async function getThread(
  opts: InboxApiClientOptions,
  emailId: string,
): Promise<InboxApiEmail[]> {
  const result = await callMcpTool(opts, "get_thread", { email_id: emailId });
  return parseJsonResult<InboxApiEmail[]>(result);
}

/** Send a new email */
export async function sendEmail(
  opts: InboxApiClientOptions,
  params: {
    to: string;
    subject: string;
    body: string;
    from_name?: string;
  },
): Promise<{ success: boolean; messageId?: string }> {
  const args: Record<string, unknown> = {
    to: params.to,
    subject: params.subject,
    body: params.body,
  };
  if (params.from_name ?? opts.fromName) {
    args.from_name = params.from_name ?? opts.fromName;
  }
  const result = await callMcpTool(opts, "send_email", args);
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    // Some responses are just confirmation text
    return { success: !result.isError, messageId: undefined };
  }
}

/** Reply to an existing email */
export async function sendReply(
  opts: InboxApiClientOptions,
  params: {
    email_id: string;
    body: string;
    from_name?: string;
  },
): Promise<{ success: boolean; messageId?: string }> {
  const args: Record<string, unknown> = {
    email_id: params.email_id,
    body: params.body,
  };
  if (params.from_name ?? opts.fromName) {
    args.from_name = params.from_name ?? opts.fromName;
  }
  const result = await callMcpTool(opts, "send_reply", args);
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    return { success: !result.isError, messageId: undefined };
  }
}

/** Get the address book */
export async function getAddressbook(
  opts: InboxApiClientOptions,
): Promise<Array<{ name: string; email: string }>> {
  const result = await callMcpTool(opts, "get_addressbook");
  return parseJsonResult<Array<{ name: string; email: string }>>(result);
}
