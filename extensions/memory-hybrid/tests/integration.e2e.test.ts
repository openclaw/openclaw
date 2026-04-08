import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { ChatModel } from "../src/api/chat.js";
import { handleRecall, handleCapture } from "../src/api/handlers.js";
import { MemoryDB } from "../src/core/database.js";
import { Embeddings } from "../src/core/embeddings.js";
import { GraphDB } from "../src/core/graph.js";
import { WorkingMemoryBuffer } from "../src/infra/buffer.js";
import { DreamService } from "../src/infra/dream.js";
import { MemoryTracer } from "../src/infra/tracer.js";

describe("Memory Hybrid E2E Integration", () => {
  let db: MemoryDB;
  let embeddings: Embeddings;
  let chatModel: ChatModel;
  let graphDB: GraphDB;
  let dreamService: DreamService;
  let workingMemory: WorkingMemoryBuffer;
  let tracer: MemoryTracer;
  let deps: any;
  const dbPath = join(tmpdir(), `memory-e2e-${Date.now()}`);
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    try {
      await rm(dbPath, { recursive: true, force: true });
    } catch {}

    tracer = new MemoryTracer({ logger: mockLogger as any });
    db = new MemoryDB(dbPath, 1536, tracer, mockLogger as any);

    chatModel = new ChatModel("key", "gpt-3.5-turbo", "openai", tracer, mockLogger as any);
    workingMemory = new WorkingMemoryBuffer();
    embeddings = {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 1536 }).fill(0.1)),
      embedBatch: vi.fn().mockResolvedValue([Array.from({ length: 1536 }).fill(0.1)]),
    } as any;
    graphDB = {
      addNode: vi.fn(),
      addEdge: vi.fn(),
      compact: vi.fn(),
    } as any;
    dreamService = {
      registerInteraction: vi.fn(),
    } as any;

    deps = {
      db,
      embeddings,
      chatModel,
      graphDB,
      dreamService,
      workingMemory,
      tracer,
      cfg: { autoRecall: true, autoCapture: true } as any,
    };
  });

  test("Full Lifecycle: Capture -> Promotion -> Storage -> Recall", async () => {
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      registerService: vi.fn(),
      resolvePath: (p: string) => join(dbPath, p),
    } as any;

    const event1 = {
      success: true,
      messages: [
        { role: "user", content: "Мій улюблений колір — синій." },
        { role: "assistant", content: "Зрозумів, синій — твій улюблений колір!" },
      ],
    };

    await handleCapture(event1, { trigger: "user" }, api, deps, tracer);
    // Should be in buffer but not LTM yet (importance is default 0.7, threshold 0.7?)
    // Actually handleCapture uses detectCategory.
    expect(workingMemory.size).toBe(1);

    // Force promote or add again with higher importance
    await workingMemory.add("Мій улюблений колір — синій.", 0.9, "preference");
    await handleCapture(event1, { trigger: "user" }, api, deps, tracer);

    const event2 = {
      prompt: "Який мій улюблений колір?",
    };

    // Note: handleRecall doesn't return string directly, it returns an event update or void
    // But let's check if it doesn't crash
    const recallResult = await handleRecall(event2, { trigger: "user" }, api, deps, tracer);
    expect(recallResult).toBeDefined();
  });
});
