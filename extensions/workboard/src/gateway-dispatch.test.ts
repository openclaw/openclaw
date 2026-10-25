import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard exact-card gateway dispatch", () => {
  it("dispatches one exact RPC card without enumerating or mutating unrelated cards", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      type RegisteredMethod = {
        handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
        opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
      };
      const methods = new Map<string, RegisteredMethod>();
      const run = vi.fn().mockResolvedValue({ runId: "run-target" });
      const api = {
        runtime: {
          state: { openKeyedStore: vi.fn() },
          subagent: { run },
        },
        registerGatewayMethod: vi.fn(
          (
            method: string,
            handler: RegisteredMethod["handler"],
            opts: RegisteredMethod["opts"],
          ) => {
            methods.set(method, { handler, opts });
          },
        ),
      } as unknown as OpenClawPluginApi;
      const store = createWorkboardSqliteTestStore();
      const stale = await store.create({
        title: "Unrelated expired worker",
        status: "ready",
        boardId: "ops",
        agentId: "expired-owner",
      });
      await store.claim(stale.id, {
        ownerId: "expired-owner",
        token: "expired-token",
        ttlSeconds: 1,
      });
      const sibling = await store.create({
        title: "Unrelated urgent card",
        status: "ready",
        priority: "urgent",
        boardId: "ops",
        agentId: "urgent-owner",
        workspaceAccess: { unrestricted: true },
      });
      const target = await store.create({
        title: "Exact RPC target",
        status: "ready",
        priority: "low",
        boardId: "ops",
        agentId: "target-owner",
        workspaceAccess: { unrestricted: true },
      });
      vi.setSystemTime(1_000_000 + 10 * 60 * 1000);
      const staleBefore = await store.get(stale.id);
      const siblingBefore = await store.get(sibling.id);
      const list = vi.spyOn(store, "list");
      registerWorkboardGatewayMethods({ api, store });
      const manifest = JSON.parse(
        fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
      ) as {
        dashboard?: {
          actionVerbs?: Array<{
            id?: string;
            method?: string;
            paramShape?: {
              required?: string[];
              properties?: Record<string, unknown>;
            };
          }>;
        };
      };
      const exactAction = manifest.dashboard?.actionVerbs?.find(
        (entry) => entry.id === "dispatch-exact",
      );
      expect(exactAction).toMatchObject({
        method: "workboard.cards.dispatchExact",
        paramShape: {
          required: ["cardId"],
          properties: {
            boardId: expect.any(Object),
            cardId: expect.objectContaining({ type: "string", minLength: 1 }),
          },
        },
      });
      const exactHandler = exactAction?.method
        ? methods.get(exactAction.method)?.handler
        : undefined;
      expect(exactHandler).toBeDefined();
      const respond = vi.fn();
      const intentRunId = `wb-${"a".repeat(40)}`;

      await exactHandler?.({
        params: { boardId: "ops", cardId: target.id, intentRunId },
        context: { getRuntimeConfig: () => ({}) },
        respond,
      } as never);

      expect(list).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledOnce();
      const expectedKey = `workboard:intent:${createHash("sha256")
        .update(target.id)
        .update("\0")
        .update(intentRunId)
        .digest("hex")}`;
      expect(run.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: expectedKey });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        started: [expect.objectContaining({ cardId: target.id, runId: "run-target" })],
      });
      expect(respond.mock.calls[0]?.[1]?.started[0]).not.toHaveProperty("card");
      await expect(store.get(target.id)).resolves.toMatchObject({
        status: "running",
        metadata: {
          automation: {
            dispatchCount: 1,
            lastDispatchAt: Date.now(),
            launch: { provisionalRunId: expectedKey, acceptedRunId: "run-target" },
          },
          claim: { ownerId: "target-owner" },
        },
      });
      await expect(store.get(stale.id)).resolves.toEqual(staleBefore);
      await expect(store.get(sibling.id)).resolves.toEqual(siblingBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exact-card validation fail-closed at the RPC boundary", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const run = vi.fn();
    const api = {
      runtime: {
        state: { openKeyedStore: vi.fn() },
        subagent: { run },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatchWithOptions")?.handler;
    const exactHandler = methods.get("workboard.cards.dispatchExact")?.handler;

    const legacyCardRespond = vi.fn();
    await methods
      .get("workboard.cards.dispatch")
      ?.handler({ params: { cardId: "card-1" }, respond: legacyCardRespond } as never);
    expect(legacyCardRespond.mock.calls[0]?.[0]).toBe(false);
    expect(legacyCardRespond.mock.calls[0]?.[2]?.message).toBe(
      "cardId requires workboard.cards.dispatchExact.",
    );

    const optionsCardRespond = vi.fn();
    await handler?.({ params: { cardId: "card-1" }, respond: optionsCardRespond } as never);
    expect(optionsCardRespond.mock.calls[0]?.[0]).toBe(false);
    expect(optionsCardRespond.mock.calls[0]?.[2]?.message).toBe(
      "cardId requires workboard.cards.dispatchExact.",
    );

    const missingExactCardRespond = vi.fn();
    await exactHandler?.({ params: {}, respond: missingExactCardRespond } as never);
    expect(missingExactCardRespond.mock.calls[0]?.[0]).toBe(false);
    expect(missingExactCardRespond.mock.calls[0]?.[2]?.message).toBe(
      "cardId is required for workboard.cards.dispatchExact.",
    );

    for (const value of ["", "   ", 42]) {
      const invalidCardRespond = vi.fn();
      await exactHandler?.({ params: { cardId: value }, respond: invalidCardRespond } as never);
      expect(invalidCardRespond.mock.calls[0]?.[0]).toBe(false);
      expect(invalidCardRespond.mock.calls[0]?.[2]?.message).toBe(
        "cardId must be a non-empty string.",
      );
    }

    for (const value of ["", "   ", 42]) {
      const invalidBoardRespond = vi.fn();
      await handler?.({ params: { boardId: value }, respond: invalidBoardRespond } as never);
      expect(invalidBoardRespond.mock.calls[0]?.[0]).toBe(false);
      expect(invalidBoardRespond.mock.calls[0]?.[2]?.message).toBe(
        "boardId must be a non-empty string.",
      );
    }

    const unscopedIntent = vi.fn();
    await handler?.({
      params: { intentRunId: `wb-${"b".repeat(40)}` },
      respond: unscopedIntent,
    } as never);
    expect(unscopedIntent.mock.calls[0]?.[2]?.message).toBe(
      "intentRunId requires one exact card through dispatchExact.",
    );
    for (const value of ["bad", 42, `wb-${"A".repeat(40)}`]) {
      const invalidIntent = vi.fn();
      await exactHandler?.({
        params: { cardId: "card-1", intentRunId: value },
        respond: invalidIntent,
      } as never);
      expect(invalidIntent.mock.calls[0]?.[2]?.message).toBe(
        "intentRunId must be a wb-<40 lowercase hex> dispatch intent id.",
      );
    }

    const exactCapRespond = vi.fn();
    await exactHandler?.({
      params: { cardId: "card-1", maxStarts: 2 },
      respond: exactCapRespond,
    } as never);
    expect(exactCapRespond.mock.calls[0]?.[0]).toBe(false);
    expect(exactCapRespond.mock.calls[0]?.[2]?.message).toBe(
      "maxStarts must be 1 when cardId is provided.",
    );
    expect(run).not.toHaveBeenCalled();
  });
});
