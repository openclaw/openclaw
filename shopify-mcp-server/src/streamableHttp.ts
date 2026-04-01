/**
 * Streamable HTTP Transport for MCP Server
 * Provides HTTP-based transport for better n8n integration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import cors from "cors";
import express, { Express, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

interface StreamableHTTPTransportOptions {
  port?: number;
  host?: string;
  serverName?: string;
}

interface Session {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  initialized: boolean;
  clientInfo?: any;
}

export class StreamableHTTPTransport {
  private app: Express;
  private sessions: Map<string, Session> = new Map();
  private port: number;
  private host: string;
  private serverName: string;
  private mcpServer: McpServer;
  private httpServer: any;

  constructor(mcpServer: McpServer, options: StreamableHTTPTransportOptions = {}) {
    this.port = options.port || 8080;
    this.host = options.host || "0.0.0.0";
    this.serverName = options.serverName || "mcp-server";
    this.app = express();
    this.mcpServer = mcpServer;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Enable CORS for all origins (adjust for production)
    this.app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Accept", "X-MCP-Session-Id", "Mcp-Session-Id"],
        credentials: false,
      }),
    );

    // Parse JSON bodies
    this.app.use(express.json({ limit: "50mb" }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get("/health", (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        server: this.serverName,
        sessions: this.sessions.size,
        uptime: process.uptime(),
      });
    });

    // MCP info endpoint
    this.app.get("/mcp/v1/info", (req: Request, res: Response) => {
      res.json({
        protocolVersion: "1.0.0",
        serverName: this.serverName,
        capabilities: {
          tools: true,
          resources: false,
          prompts: false,
          logging: false,
          completion: false,
        },
      });
    });

    // Main MCP message endpoint
    this.app.post("/mcp/v1/message", async (req: Request, res: Response) => {
      try {
        const sessionId =
          (req.headers["x-mcp-session-id"] as string) ||
          (req.headers["mcp-session-id"] as string) ||
          uuidv4();

        let session = this.sessions.get(sessionId);
        if (!session) {
          session = {
            id: sessionId,
            createdAt: new Date(),
            lastActivity: new Date(),
            initialized: false,
          };
          this.sessions.set(sessionId, session);
        }

        session.lastActivity = new Date();

        const message = req.body;
        console.log(`[Session ${sessionId}] Processing message:`, message.method || message.type);

        // Handle different message types
        let response: any;

        if (message.method === "initialize") {
          response = await this.handleInitialize(message, session);
        } else if (message.method === "tools/list") {
          response = await this.handleToolsList(message);
        } else if (message.method === "tools/call") {
          response = await this.handleToolCall(message);
        } else if (message.method === "ping") {
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: { type: "pong" },
          };
        } else {
          // Try to handle through the MCP server directly
          response = await this.handleGenericMessage(message);
        }

        res.json(response);
      } catch (error: any) {
        console.error("Error processing message:", error);
        res.status(500).json({
          jsonrpc: "2.0",
          id: req.body.id || null,
          error: {
            code: -32603,
            message: error.message || "Internal error",
            data: error.stack,
          },
        });
      }
    });

    // Session cleanup endpoint
    this.app.post("/mcp/v1/session/close", (req: Request, res: Response) => {
      const sessionId =
        (req.headers["x-mcp-session-id"] as string) || (req.headers["mcp-session-id"] as string);

      if (sessionId && this.sessions.has(sessionId)) {
        this.sessions.delete(sessionId);
        res.json({ status: "closed", sessionId });
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    });

    // List active sessions (for debugging)
    this.app.get("/mcp/v1/sessions", (req: Request, res: Response) => {
      const sessions = Array.from(this.sessions.entries()).map(([id, session]) => ({
        id,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        initialized: session.initialized,
      }));
      res.json({ sessions });
    });
  }

  private async handleInitialize(message: any, session: Session): Promise<any> {
    try {
      const result = {
        protocolVersion: "1.0.0",
        serverInfo: {
          name: this.serverName,
          version: "1.0.0",
        },
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
      };

      session.initialized = true;
      session.clientInfo = message.params?.clientInfo;

      return {
        jsonrpc: "2.0",
        id: message.id,
        result,
      };
    } catch (error: any) {
      throw new Error(`Initialize failed: ${error.message}`, { cause: error });
    }
  }

  private async handleToolsList(message: any): Promise<any> {
    try {
      // Get tools from the MCP server
      const tools = (this.mcpServer as any)._tools || [];

      const toolsList = Array.from(tools.entries()).map((entry: any) => {
        const [name, tool] = entry as [string, any];
        return {
          name,
          description: tool.description || "",
          inputSchema: tool.schema || {},
        };
      });

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: toolsList,
        },
      };
    } catch (error: any) {
      throw new Error(`Tools list failed: ${error.message}`, { cause: error });
    }
  }

  private async handleToolCall(message: any): Promise<any> {
    try {
      const { name, arguments: args } = message.params;

      // Get the tool handler from the MCP server
      const tools = (this.mcpServer as any)._tools;
      const tool = tools?.get(name);

      if (!tool) {
        throw new Error(`Tool '${name}' not found`);
      }

      // Execute the tool
      const result = await tool.handler(args || {});

      return {
        jsonrpc: "2.0",
        id: message.id,
        result,
      };
    } catch (error: any) {
      throw new Error(`Tool call failed: ${error.message}`, { cause: error });
    }
  }

  private async handleGenericMessage(message: any): Promise<any> {
    // This would handle other message types through the MCP server
    // For now, return an error for unsupported methods
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Method '${message.method}' not found`,
      },
    };
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(this.port, this.host, () => {
        console.log(`${this.serverName} HTTP transport listening on ${this.host}:${this.port}`);

        // Clean up old sessions periodically
        setInterval(
          () => {
            const now = new Date();
            const timeout = 30 * 60 * 1000; // 30 minutes

            for (const [id, session] of this.sessions.entries()) {
              if (now.getTime() - session.lastActivity.getTime() > timeout) {
                this.sessions.delete(id);
                console.log(`Cleaned up inactive session: ${id}`);
              }
            }
          },
          5 * 60 * 1000,
        ); // Check every 5 minutes

        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          console.log(`${this.serverName} HTTP transport stopped`);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
