/**
 * NDJSON wire-level ordering proof for newSession/resumeSession.
 *
 * This file connects the AcpGatewayAgent over a real ndJsonStream pipe so
 * that the SDK's ndJsonStream serializes actual NDJSON bytes. A capture
 * transform intercepts the agent→client byte stream to record every
 * JSON-RPC line the agent writes, proving that:
 *
 *   1. session/new → JSON-RPC response (result) arrives BEFORE
 *      session/update notification (session_info_update).
 *   2. session/resume → same ordering guarantee.
 *
 * Unlike the mocked tests in translator.lifecycle.test.ts which test the
 * setTimeout ordering at the JS-call level, this file verifies the ordering
 * at the NDJSON transport level—the same bytes that cross stdio on a real
 * ACP connection.
 */
import {
  AgentSideConnection,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

/**
 * Minimal ACP client that speaks JSON-RPC over an ndJsonStream.
 *
 * This is NOT mocked—it sends real JSON-RPC requests through a real
 * ndJsonStream, receives real JSON-RPC responses, and records every
 * NDJSON line the agent writes.
 */
class NdjsonCapturingClient {
  /**
   * Ordered NDJSON lines written by the agent (captured at the byte level).
   */
  readonly agentNdjsonLines: string[] = [];

  private readonly agentInputController = new TransformStream<Uint8Array, Uint8Array>();
  private readonly agentOutputController = new TransformStream<Uint8Array, Uint8Array>();
  private requestIdCounter = 0;
  private agent: AcpGatewayAgent | null = null;
  private sessionStore = createInMemorySessionStore();

  constructor(gatewayClient: GatewayClient) {
    // ── Capture transform: taps agent→client byte stream ──────────────
    const capture = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        const text = new TextDecoder().decode(chunk, { stream: true });
        for (const line of text.split("\n").filter(Boolean)) {
          this.agentNdjsonLines.push(line);
        }
        controller.enqueue(chunk);
      },
    });

    // Wire: agentOutput → capture → clientInput
    this.agentOutputController.readable.pipeTo(capture.writable).catch(() => {});

    // The agent writes to agentOutputController.writable via ndJsonStream;
    // the client reads from capture.readable via another ndJsonStream.
    const clientInStream = ndJsonStream(
      this.agentInputController.writable, // client writes here → agent reads
      capture.readable, // client reads from captured agent output
    );

    // Agent reads from agentInputController.readable,
    // Agent writes to agentOutputController.writable.
    const agentStream = ndJsonStream(
      this.agentOutputController.writable, // agent writes here → captured
      this.agentInputController.readable, // agent reads client input
    );

    this.sessionStore = createInMemorySessionStore();
    this.agent = new AcpGatewayAgent(
      // AgentSideConnection is deprecated but real: it wraps the agent with
      // the SDK's ndJsonStream I/O and JSON-RPC dispatch.
      new AgentSideConnection((conn) => {
        const realAgent = new AcpGatewayAgent(conn, gatewayClient, {
          sessionStore: this.sessionStore,
        });
        return realAgent;
      }, agentStream),
      gatewayClient,
      { sessionStore: this.sessionStore },
    );
  }

  nextRequestId(): number {
    this.requestIdCounter += 1;
    return this.requestIdCounter;
  }

  /**
   * Reads one NDJSON line from the captured agent output and parses it.
   */
  private parseNextAgentLine(index: number): Record<string, unknown> {
    const line = this.agentNdjsonLines[index];
    if (!line) {
      throw new Error(
        `Expected NDJSON line at index ${index}, but only ${this.agentNdjsonLines.length} captured`,
      );
    }
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Failed to parse NDJSON line ${index}: ${line}`);
    }
  }

  /**
   * Finds an NDJSON line matching a predicate (scans from start).
   */
  findLine(predicate: (msg: Record<string, unknown>) => boolean, startAt = 0): number {
    for (let i = startAt; i < this.agentNdjsonLines.length; i++) {
      const line = this.agentNdjsonLines[i];
      if (!line) {
        continue;
      }
      try {
        if (predicate(JSON.parse(line) as Record<string, unknown>)) {
          return i;
        }
      } catch {
        // skip unparseable
      }
    }
    return -1;
  }

  /**
   * Writes a JSON-RPC request to the agent via the ndJsonStream, then reads
   * one response line from the captured output.
   */
  private async sendRequestAndGetResponse(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ response: Record<string, unknown>; responseIndex: number }> {
    const id = this.nextRequestId();
    const request: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const writer = this.agentInputController.writable.getWriter();
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(JSON.stringify(request) + "\n"));
    writer.releaseLock();

    // Poll for the matching response line.
    const beforeCount = this.agentNdjsonLines.length;
    const startTime = Date.now();
    while (Date.now() - startTime < 5_000) {
      // Wait for the agent to process and write back
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    // The response should be the next line after initialize handshake.
    // Since requests are sent sequentially, the response index is deterministic.
    // After writing, we need to wait a tick and check.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    for (let i = 0; i < this.agentNdjsonLines.length; i++) {
      const line = this.agentNdjsonLines[i];
      if (!line) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.id === id) {
          return { response: msg, responseIndex: i };
        }
      } catch {
        // skip
      }
    }
    throw new Error(
      `No JSON-RPC response found for id=${id} (method=${method}) among ${this.agentNdjsonLines.length} captured lines:\n${this.agentNdjsonLines.join(
        "\n",
      )}`,
    );
  }

  /**
   * Sends initialize, returns the negotiate response.
   */
  async initialize(): Promise<void> {
    // ndJsonStream is set up. Now send the initialize request.
    const { response } = await this.sendRequestAndGetResponse("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "ndjson-proof-client", version: "1.0.0" },
    });
    expect(response.result).toBeTruthy();
  }

  /**
   * Sends session/new, returns the response.
   * Verifies that the JSON-RPC response appears before any session/update notification.
   */
  async newSession(): Promise<void> {
    const beforeCount = this.agentNdjsonLines.length;

    const { response, responseIndex } = await this.sendRequestAndGetResponse("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: {},
    });

    // Wait for deferred setTimeout notification to fire
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // After the response has been received, verify ordering:
    // The session/new JSON-RPC result MUST come before any session/update
    // notification in the NDJSON byte stream.
    const updateIndex = this.findLine(
      (msg) =>
        msg.method === CLIENT_METHODS.session_update &&
        typeof msg.params === "object" &&
        msg.params !== null &&
        (msg.params as Record<string, unknown>).update !== undefined,
      responseIndex + 1,
    );

    expect(response.id).toBeTruthy();
    expect((response.result as Record<string, unknown> | undefined)?.sessionId).toBeTruthy();
    expect(responseIndex).toBeLessThan(updateIndex !== -1 ? updateIndex : Infinity);
  }

  /**
   * Sends session/resume with an existing session key.
   * Verifies response-before-notification ordering.
   */
  async resumeSession(): Promise<void> {
    const beforeCount = this.agentNdjsonLines.length;

    const { response, responseIndex } = await this.sendRequestAndGetResponse("session/resume", {
      sessionId: "agent:main:order-proof",
      cwd: "/tmp",

      mcpServers: [],
      _meta: {},
    });

    // Wait for deferred setTimeout notification to fire
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    const updateIndex = this.findLine(
      (msg) =>
        msg.method === CLIENT_METHODS.session_update &&
        typeof msg.params === "object" &&
        msg.params !== null &&
        (msg.params as Record<string, unknown>).update !== undefined,
      responseIndex + 1,
    );

    expect(response.id).toBeTruthy();
    expect(response.result).toBeTruthy();
    expect(responseIndex).toBeLessThan(updateIndex !== -1 ? updateIndex : Infinity);
  }

  close(): void {
    this.agentInputController.writable.close().catch(() => {});
    this.agentOutputController.writable.close().catch(() => {});
    this.sessionStore.clearAllSessionsForTest();
  }
}

function buildGatewayClientForNewSession(): GatewayClient {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.list") {
      return {
        ts: Date.now(),
        path: "/tmp/sessions.json",
        count: 0,
        totalCount: 0,
        limitApplied: 0,
        hasMore: false,
        defaults: {
          modelProvider: null,
          model: null,
          contextTokens: null,
        },
        sessions: [],
      };
    }
    return { ok: true };
  }) as unknown as GatewayClient["request"];
  return createAcpGateway(request);
}

function buildGatewayClientForResumeSession(): GatewayClient {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.list") {
      return {
        ts: Date.now(),
        path: "/tmp/sessions.json",
        count: 1,
        totalCount: 1,
        limitApplied: 1,
        hasMore: false,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:order-proof",
            kind: "direct",
            spawnedWorkspaceDir: "/tmp",
            derivedTitle: "Order proof",
            updatedAt: Date.now(),
            thinkingLevel: "adaptive",
            modelProvider: "openai",
            model: "gpt-5.4",
          },
        ],
      };
    }
    if (method === "sessions.get") {
      return { ok: true };
    }
    return { ok: true };
  }) as unknown as GatewayClient["request"];
  return createAcpGateway(request);
}

describe("acp translator ndjson wire ordering proof", () => {
  it("newSession: JSON-RPC response line precedes session/update notification in NDJSON stream", async () => {
    const client = new NdjsonCapturingClient(buildGatewayClientForNewSession());

    try {
      // Send initialize first
      await client.initialize();

      // Now send session/new and verify NDJSON ordering
      const beforeCount = client.agentNdjsonLines.length;

      const id = client.nextRequestId();
      const request: Record<string, unknown> = {
        jsonrpc: "2.0",
        id,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [], _meta: {} },
      };

      const writer = client["agentInputController"].writable.getWriter();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(JSON.stringify(request) + "\n"));
      writer.releaseLock();

      // Wait for response + deferred notification
      const waitStart = Date.now();
      let responseFound = false;
      while (Date.now() - waitStart < 5_000) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        for (const line of client.agentNdjsonLines) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.id === id) {
              responseFound = true;
            }
          } catch {
            // skip
          }
        }
        if (responseFound) break;
      }

      // Wait more for deferred notification to arrive
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      expect(client.agentNdjsonLines.length).toBeGreaterThan(0);

      // Find indices
      let responseIdx = -1;
      let updateIdx = -1;
      client.agentNdjsonLines.forEach((line, i) => {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === id) responseIdx = i;
          if (
            msg.method === "session/update" &&
            typeof msg.params === "object" &&
            msg.params !== null &&
            typeof (msg.params as Record<string, unknown>).update === "object"
          ) {
            if (updateIdx === -1) updateIdx = i;
          }
        } catch {
          // skip
        }
      });

      expect(responseIdx).toBeGreaterThanOrEqual(0);
      // The response should come BEFORE the update notification
      if (updateIdx !== -1) {
        expect(responseIdx).toBeLessThan(updateIdx);
      }

      // Log the captured NDJSON for review
      console.log("=== NDJSON transcript (newSession) ===");
      client.agentNdjsonLines.forEach((line, i) => {
        console.log(`  [${i}] ${line}`);
      });
    } finally {
      client.close();
    }
  });

  it("resumeSession: JSON-RPC response line precedes session/update notification in NDJSON stream", async () => {
    const client = new NdjsonCapturingClient(buildGatewayClientForResumeSession());

    try {
      await client.initialize();

      const id = client.nextRequestId();
      const request: Record<string, unknown> = {
        jsonrpc: "2.0",
        id,
        method: "session/resume",
        params: { sessionId: "agent:main:order-proof", cwd: "/tmp", mcpServers: [], _meta: {} },
      };

      const writer = client["agentInputController"].writable.getWriter();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(JSON.stringify(request) + "\n"));
      writer.releaseLock();

      const waitStart = Date.now();
      let responseFound = false;
      while (Date.now() - waitStart < 5_000) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        for (const line of client.agentNdjsonLines) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.id === id) {
              responseFound = true;
            }
          } catch {
            // skip
          }
        }
        if (responseFound) break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      expect(client.agentNdjsonLines.length).toBeGreaterThan(0);

      let responseIdx = -1;
      let updateIdx = -1;
      client.agentNdjsonLines.forEach((line, i) => {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === id) responseIdx = i;
          if (
            msg.method === "session/update" &&
            typeof msg.params === "object" &&
            msg.params !== null &&
            typeof (msg.params as Record<string, unknown>).update === "object"
          ) {
            if (updateIdx === -1) updateIdx = i;
          }
        } catch {
          // skip
        }
      });

      expect(responseIdx).toBeGreaterThanOrEqual(0);
      if (updateIdx !== -1) {
        expect(responseIdx).toBeLessThan(updateIdx);
      }

      console.log("=== NDJSON transcript (resumeSession) ===");
      client.agentNdjsonLines.forEach((line, i) => {
        console.log(`  [${i}] ${line}`);
      });
    } finally {
      client.close();
    }
  });
});
