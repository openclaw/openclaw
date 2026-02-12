/**
 * MockMatrixServer — test-friendly wrapper around MockHomeserver.
 *
 * Adds the `baseUrl` property and `getRequestsMatching()` query method
 * expected by the outbound-encrypt integration test.
 */

import { MockHomeserver, type SentEvent } from "../integration/mock-homeserver.js";

export interface RequestMatch {
  method?: string;
  path?: string | RegExp;
}

export interface CapturedRequest {
  roomId: string;
  eventType: string;
  txnId: string;
  path: string;
  body: any;
}

export class MockMatrixServer {
  private inner: MockHomeserver;

  constructor() {
    this.inner = new MockHomeserver({ accessToken: "test_token_12345" });
  }

  get baseUrl(): string {
    return this.inner.url;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  /**
   * Query captured requests by method and path pattern.
   * Returns matching requests with their full PUT path for txnId extraction.
   */
  getRequestsMatching(match: RequestMatch): CapturedRequest[] {
    return this.inner.sentEvents
      .filter((evt) => {
        // All captured events are PUTs; check method if specified
        if (match.method && match.method !== "PUT") return false;

        // Build the full path as it appears on the wire
        const fullPath = `/_matrix/client/v3/rooms/${encodeURIComponent(evt.roomId)}/send/${encodeURIComponent(evt.eventType)}/${evt.txnId}`;

        if (match.path instanceof RegExp) {
          return match.path.test(fullPath);
        }
        if (typeof match.path === "string") {
          return fullPath.includes(match.path);
        }
        return true;
      })
      .map((evt) => ({
        roomId: evt.roomId,
        eventType: evt.eventType,
        txnId: evt.txnId,
        path: `/_matrix/client/v3/rooms/${encodeURIComponent(evt.roomId)}/send/${encodeURIComponent(evt.eventType)}/${evt.txnId}`,
        body: evt.body,
      }));
  }

  /**
   * Set the joined members for a room, so /joined_members returns them.
   */
  setRoomMembers(roomId: string, userIds: string[]): void {
    const joined: Record<string, unknown> = {};
    for (const uid of userIds) joined[uid] = {};
    this.inner.roomMembers.set(roomId, joined);
  }

  reset(): void {
    this.inner.reset();
  }
}
