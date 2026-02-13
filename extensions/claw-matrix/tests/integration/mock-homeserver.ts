/**
 * Mock Matrix homeserver for integration testing.
 *
 * A minimal HTTP server that responds to the Matrix Client-Server API endpoints
 * used by claw-matrix. Designed to be started/stopped per test suite.
 *
 * Supports:
 * - /sync (configurable responses)
 * - /send (captures sent events)
 * - /keys/* (stub key endpoints)
 * - /upload (stub media upload)
 * - /directory/room (alias resolution)
 * - /joined_rooms
 * - /user/.../account_data/m.direct
 *
 * Usage:
 *   const server = new MockHomeserver();
 *   await server.start();
 *   // ... run tests against server.url ...
 *   await server.stop();
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface SentEvent {
  roomId: string;
  eventType: string;
  txnId: string;
  body: unknown;
}

export interface MockHomeserverOptions {
  /** Port to listen on. Default: 0 (random). */
  port?: number;
  /** Access token to require. Default: "mock-token". */
  accessToken?: string;
}

export class MockHomeserver {
  private server: Server | null = null;
  private _port: number;
  private _accessToken: string;

  /** Events sent via PUT /rooms/.../send/... */
  public sentEvents: SentEvent[] = [];

  /** Configurable sync response. Set before calling /sync. */
  public syncResponse: Record<string, unknown> = {
    next_batch: "s1_mock",
    rooms: { join: {}, invite: {}, leave: {} },
  };

  /** Room alias → room ID mapping for directory lookups. */
  public aliasMap = new Map<string, string>();

  /** m.direct account data: userId → roomIds */
  public mDirectData: Record<string, string[]> = {};

  /** Joined rooms list */
  public joinedRooms: string[] = [];

  /** Per-room joined members: roomId → { userId: {} } */
  public roomMembers = new Map<string, Record<string, unknown>>();

  /** Key upload responses */
  public oneTimeKeyCounts: Record<string, number> = { signed_curve25519: 50 };

  constructor(opts?: MockHomeserverOptions) {
    this._port = opts?.port ?? 0;
    this._accessToken = opts?.accessToken ?? "mock-token";
  }

  get url(): string {
    if (!this.server) throw new Error("Server not started");
    const addr = this.server.address();
    if (typeof addr === "string" || !addr) throw new Error("Server address unavailable");
    return `http://127.0.0.1:${addr.port}`;
  }

  get port(): number {
    if (!this.server) throw new Error("Server not started");
    const addr = this.server.address();
    if (typeof addr === "string" || !addr) throw new Error("Server address unavailable");
    return addr.port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", reject);
      this.server.listen(this._port, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = null;
    });
  }

  reset(): void {
    this.sentEvents = [];
    this.syncResponse = {
      next_batch: "s1_mock",
      rooms: { join: {}, invite: {}, leave: {} },
    };
    this.aliasMap.clear();
    this.mDirectData = {};
    this.joinedRooms = [];
    this.roomMembers.clear();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Auth check (skip for well-known and login)
    if (!path.includes("/login") && !path.includes("/.well-known")) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this._accessToken}`) {
        this.json(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" });
        return;
      }
    }

    try {
      // Route requests
      if (path.includes("/_matrix/client/v3/sync") || path.includes("/_matrix/client/r0/sync")) {
        this.json(res, 200, this.syncResponse);
        return;
      }

      // PUT /rooms/{roomId}/send/{eventType}/{txnId}
      const sendMatch = path.match(/\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/(.+)/);
      if (sendMatch && method === "PUT") {
        const body = await this.readBody(req);
        this.sentEvents.push({
          roomId: decodeURIComponent(sendMatch[1]),
          eventType: decodeURIComponent(sendMatch[2]),
          txnId: decodeURIComponent(sendMatch[3]),
          body: JSON.parse(body || "{}"),
        });
        this.json(res, 200, {
          event_id: `$mock_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });
        return;
      }

      // Room alias resolution
      const aliasMatch = path.match(/\/_matrix\/client\/v3\/directory\/room\/(.+)/);
      if (aliasMatch && method === "GET") {
        const alias = decodeURIComponent(aliasMatch[1]);
        const roomId = this.aliasMap.get(alias);
        if (roomId) {
          this.json(res, 200, { room_id: roomId, servers: ["mock.server"] });
        } else {
          this.json(res, 404, { errcode: "M_NOT_FOUND", error: `Room alias ${alias} not found` });
        }
        return;
      }

      // Joined rooms
      if (path.includes("/joined_rooms") && method === "GET") {
        this.json(res, 200, { joined_rooms: this.joinedRooms });
        return;
      }

      // m.direct account data
      const mDirectMatch = path.match(
        /\/_matrix\/client\/v3\/user\/[^/]+\/account_data\/m\.direct/,
      );
      if (mDirectMatch && method === "GET") {
        this.json(res, 200, this.mDirectData);
        return;
      }

      // Key upload
      if (path.includes("/keys/upload") && method === "POST") {
        this.json(res, 200, { one_time_key_counts: this.oneTimeKeyCounts });
        return;
      }

      // Key query
      if (path.includes("/keys/query") && method === "POST") {
        this.json(res, 200, { device_keys: {}, failures: {} });
        return;
      }

      // Key claim
      if (path.includes("/keys/claim") && method === "POST") {
        this.json(res, 200, { one_time_keys: {}, failures: {} });
        return;
      }

      // Media upload
      if (path.includes("/_matrix/media/v3/upload") && method === "POST") {
        const mediaId = Math.random().toString(36).slice(2);
        this.json(res, 200, { content_uri: `mxc://mock.server/${mediaId}` });
        return;
      }

      // User profile
      const profileMatch = path.match(/\/_matrix\/client\/v3\/profile\/(.+)/);
      if (profileMatch && method === "GET") {
        this.json(res, 200, { displayname: "Mock User" });
        return;
      }

      // Room joined members
      const membersMatch = path.match(/\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members/);
      if (membersMatch && method === "GET") {
        const membersRoomId = decodeURIComponent(membersMatch[1]);
        const joined = this.roomMembers.get(membersRoomId) ?? {};
        this.json(res, 200, { joined });
        return;
      }

      // Filter creation
      if (path.includes("/filter") && method === "POST") {
        this.json(res, 200, { filter_id: "mock_filter_1" });
        return;
      }

      // Default: 404
      this.json(res, 404, {
        errcode: "M_UNRECOGNIZED",
        error: `Unknown endpoint: ${method} ${path}`,
      });
    } catch (err) {
      this.json(res, 500, { errcode: "M_UNKNOWN", error: String(err) });
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }
}
