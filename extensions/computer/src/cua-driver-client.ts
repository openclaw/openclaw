import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type CallToolResult = {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
};

// One shared client per binary path. Reused across tool calls within a
// session — cua-driver holds AX element caches that must persist between
// get_app_state and subsequent click/type calls.
const clients = new Map<string, CuaDriverClient>();

export function getCuaDriverClient(binaryPath = "cua-driver"): CuaDriverClient {
  let client = clients.get(binaryPath);
  if (!client) {
    client = new CuaDriverClient(binaryPath);
    clients.set(binaryPath, client);
  }
  return client;
}

export class CuaDriverClient {
  private client: Client | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly binaryPath: string) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.ensureConnected();
    try {
      const result = await this.client!.callTool({ name, arguments: args });
      return result as CallToolResult;
    } catch (err) {
      // If the subprocess crashed, null the client so the next call reconnects.
      this.client = null;
      throw err;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } catch (err) {
      this.connectPromise = null;
      throw err;
    }
    this.connectPromise = null;
  }

  private async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.binaryPath,
      args: ["mcp"],
    });
    this.client = new Client({ name: "openclaw-computer", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(transport);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

// Extract the first text part and all image parts from a cua-driver result.
export function extractResult(result: CallToolResult): {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
} {
  const textParts = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  const images = result.content
    .filter((c) => c.type === "image" && c.data)
    .map((c) => ({ data: c.data!, mimeType: c.mimeType ?? "image/jpeg" }));
  return {
    text: textParts.join("\n").trim(),
    images,
    isError: result.isError === true,
  };
}
