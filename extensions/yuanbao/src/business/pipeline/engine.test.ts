/**
 * Unit tests for pipeline/engine.ts: MessagePipeline use/useBefore/useAfter/remove/execute.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MessagePipeline } from "./engine.js";
import type { PipelineContext } from "./types.js";

// Build minimal mock PipelineContext
function makeMockPipelineCtx(): PipelineContext {
  return {
    raw: {} as any,
    flushedItems: [],
    chatType: "c2c",
    account: {} as any,
    config: {} as any,
    core: {} as any,
    wsClient: {} as any,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      verbose: () => {},
    } as any,
    fromAccount: "test-user",
    rawBody: "",
    medias: [],
    isAtBot: false,
    effectiveWasMentioned: false,
    commandAuthorized: false,
    rewrittenBody: "",
    hasControlCommand: false,
    mediaPaths: [],
    mediaTypes: [],
  } as unknown as PipelineContext;
}

void test("MessagePipeline use: registers middleware and executes in order", async () => {
  const order: string[] = [];

  const pipeline = new MessagePipeline()
    .use({
      name: "first",
      handler: async (_ctx, next) => {
        order.push("first-before");
        await next();
        order.push("first-after");
      },
    })
    .use({
      name: "second",
      handler: async (_ctx, next) => {
        order.push("second-before");
        await next();
        order.push("second-after");
      },
    });

  const ctx = makeMockPipelineCtx();
  await pipeline.execute(ctx);

  assert.deepEqual(order, ["first-before", "second-before", "second-after", "first-after"]);
});

void test("MessagePipeline useBefore: inserts before specified middleware", async () => {
  const order: string[] = [];

  const pipeline = new MessagePipeline()
    .use({
      name: "a",
      handler: async (_ctx, next) => {
        order.push("a");
        await next();
      },
    })
    .use({
      name: "c",
      handler: async (_ctx, next) => {
        order.push("c");
        await next();
      },
    })
    .useBefore("c", {
      name: "b",
      handler: async (_ctx, next) => {
        order.push("b");
        await next();
      },
    });

  await pipeline.execute(makeMockPipelineCtx());
  assert.deepEqual(order, ["a", "b", "c"]);
});

void test("MessagePipeline useAfter: inserts after specified middleware", async () => {
  const order: string[] = [];

  const pipeline = new MessagePipeline()
    .use({
      name: "a",
      handler: async (_ctx, next) => {
        order.push("a");
        await next();
      },
    })
    .use({
      name: "c",
      handler: async (_ctx, next) => {
        order.push("c");
        await next();
      },
    })
    .useAfter("a", {
      name: "b",
      handler: async (_ctx, next) => {
        order.push("b");
        await next();
      },
    });

  await pipeline.execute(makeMockPipelineCtx());
  assert.deepEqual(order, ["a", "b", "c"]);
});

void test("MessagePipeline remove: removes middleware by name", async () => {
  const order: string[] = [];

  const pipeline = new MessagePipeline()
    .use({
      name: "a",
      handler: async (_ctx, next) => {
        order.push("a");
        await next();
      },
    })
    .use({
      name: "b",
      handler: async (_ctx, next) => {
        order.push("b");
        await next();
      },
    })
    .use({
      name: "c",
      handler: async (_ctx, next) => {
        order.push("c");
        await next();
      },
    })
    .remove("b");

  await pipeline.execute(makeMockPipelineCtx());
  assert.deepEqual(order, ["a", "c"]);
});

void test("MessagePipeline when: condition guard skips middleware", async () => {
  const order: string[] = [];

  const pipeline = new MessagePipeline()
    .use({
      name: "always",
      handler: async (_ctx, next) => {
        order.push("always");
        await next();
      },
    })
    .use({
      name: "group-only",
      when: (ctx) => ctx.isGroup,
      handler: async (_ctx, next) => {
        order.push("group-only");
        await next();
      },
    })
    .use({
      name: "final",
      handler: async (_ctx, next) => {
        order.push("final");
        await next();
      },
    });

  // C2C message should skip group-only
  const c2cCtx = makeMockPipelineCtx();
  await pipeline.execute(c2cCtx);
  assert.deepEqual(order, ["always", "final"]);
});

void test("MessagePipeline: middleware not calling next aborts pipeline", async () => {
  const order: string[] = [];

  const pipeline = new MessagePipeline()
    .use({
      name: "first",
      handler: async (_ctx, _next) => {
        order.push("first");
        // Do not call next(), abort pipeline
      },
    })
    .use({
      name: "second",
      handler: async (_ctx, next) => {
        order.push("second");
        await next();
      },
    });

  await pipeline.execute(makeMockPipelineCtx());
  assert.deepEqual(order, ["first"]);
});

void test("MessagePipeline: empty pipeline executes without error", async () => {
  const pipeline = new MessagePipeline();
  await pipeline.execute(makeMockPipelineCtx());
  // No exception means pass
});
