import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDatabase } from "./database/connection.js";
import { WhatsAppLabelService } from "./labels.js";
import type { Runtime } from "./runtime.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadbot-label-test-"));
  return path.join(dir, "test.db");
}

function fakeRuntime(
  labels: { id: string; name: string; color: number; deleted: boolean }[] = [],
  created?: { id: string; name: string; color: number },
): Runtime & {
  addedLabels: { jid: string; id: string }[];
  removedLabels: { jid: string; id: string }[];
  getLabelsCallCount: number;
  createLabelCalls: { name: string; color: number }[];
} {
  const addedLabels: { jid: string; id: string }[] = [];
  const removedLabels: { jid: string; id: string }[] = [];
  const createLabelCalls: { name: string; color: number }[] = [];
  let getLabelsCallCount = 0;

  return {
    addedLabels,
    removedLabels,
    getLabelsCallCount,
    createLabelCalls,
    async sendMessage() {},
    async addChatLabel(jid: string, id: string) {
      addedLabels.push({ jid, id });
    },
    async removeChatLabel(jid: string, id: string) {
      removedLabels.push({ jid, id });
    },
    async getLabels() {
      getLabelsCallCount++;
      // Update the externally visible counter
      (this as any).getLabelsCallCount = getLabelsCallCount;
      return labels;
    },
    async createLabel(name: string, color: number) {
      createLabelCalls.push({ name, color });
      return created;
    },
  };
}

const defaultConfig = {
  scores: { HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" },
  statuses: { BOT: "BOT", HUMANO: "HUMANO" },
};

describe("WhatsAppLabelService", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = new SqliteDatabase({ dbPath: tmpDb() });
    db.migrate();
  });

  describe("resolveId", () => {
    it("DB hit → returns cached ID without runtime call", async () => {
      await db.upsertLabel("HOT", "42", 0);
      await db.upsertLabel("WARM", "43", 3);
      await db.upsertLabel("COLD", "44", 7);
      await db.upsertLabel("OUT", "45", 14);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "HOT", runtime);

      expect(runtime.addedLabels).toEqual([{ jid: "525551234567@s.whatsapp.net", id: "42" }]);
      expect(runtime.getLabelsCallCount).toBe(0);
    });

    it("DB miss → runtime.getLabels resolves → upserts to DB", async () => {
      const runtime = fakeRuntime([
        { id: "99", name: "HOT", color: 0, deleted: false },
        { id: "100", name: "WARM", color: 3, deleted: false },
      ]);
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "HOT", runtime);

      expect(runtime.addedLabels[0]).toEqual({ jid: "525551234567@s.whatsapp.net", id: "99" });
      // DB should now have the label persisted
      const dbId = await db.getLabelId("HOT");
      expect(dbId).toBe("99");
    });

    it("DB miss + runtime miss → runtime.createLabel → upserts to DB", async () => {
      const runtime = fakeRuntime(
        [], // no existing labels
        { id: "201", name: "HOT", color: 0 }, // createLabel returns this
      );
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "HOT", runtime);

      expect(runtime.createLabelCalls[0]).toEqual({ name: "HOT", color: 0 });
      expect(runtime.addedLabels[0]).toEqual({ jid: "525551234567@s.whatsapp.net", id: "201" });
      const dbId = await db.getLabelId("HOT");
      expect(dbId).toBe("201");
    });

    it("case-insensitive match on runtime labels", async () => {
      const runtime = fakeRuntime([{ id: "55", name: "hot", color: 0, deleted: false }]);
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "HOT", runtime);

      expect(runtime.addedLabels[0]).toEqual({ jid: "525551234567@s.whatsapp.net", id: "55" });
    });

    it("skips deleted labels from runtime", async () => {
      const runtime = fakeRuntime([{ id: "55", name: "HOT", color: 0, deleted: true }], {
        id: "56",
        name: "HOT",
        color: 0,
      });
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "HOT", runtime);

      // Should have skipped the deleted one and created via createLabel
      const hotCreate = runtime.createLabelCalls.find((c) => c.name === "HOT");
      expect(hotCreate).toBeDefined();
      expect(runtime.addedLabels[0]?.id).toBe("56");
    });

    it("in-memory cache prevents repeated DB lookups", async () => {
      await db.upsertLabel("HOT", "42", 0);
      await db.upsertLabel("WARM", "43", 3);
      await db.upsertLabel("COLD", "44", 7);
      await db.upsertLabel("OUT", "45", 14);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      // First call populates cache
      await svc.applyScore("5215551234567", "HOT", runtime);
      // Second call should use cache
      await svc.applyScore("5215559999999", "HOT", runtime);

      // Both should succeed with the same ID
      expect(runtime.addedLabels).toHaveLength(2);
      expect(runtime.addedLabels[0]!.id).toBe("42");
      expect(runtime.addedLabels[1]!.id).toBe("42");
    });
  });

  describe("applyScore", () => {
    it("applies correct label and removes other score labels", async () => {
      await db.upsertLabel("HOT", "10", 0);
      await db.upsertLabel("WARM", "11", 3);
      await db.upsertLabel("COLD", "12", 7);
      await db.upsertLabel("OUT", "13", 14);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "HOT", runtime);

      expect(runtime.addedLabels).toEqual([{ jid: "525551234567@s.whatsapp.net", id: "10" }]);
      // Should remove WARM, COLD, OUT
      const removedIds = runtime.removedLabels.map((r) => r.id);
      expect(removedIds).toContain("11");
      expect(removedIds).toContain("12");
      expect(removedIds).toContain("13");
      expect(removedIds).not.toContain("10");
    });

    it("no-ops for unknown score", async () => {
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyScore("5215551234567", "INVALID", runtime);

      expect(runtime.addedLabels).toHaveLength(0);
    });
  });

  describe("applyStatus", () => {
    it("BOT status: adds BOT label, removes HUMANO label", async () => {
      await db.upsertLabel("BOT", "20", 4);
      await db.upsertLabel("HUMANO", "21", 5);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyStatus("5215551234567", "qualifying", runtime);

      expect(runtime.addedLabels).toEqual([{ jid: "525551234567@s.whatsapp.net", id: "20" }]);
      expect(runtime.removedLabels).toEqual([{ jid: "525551234567@s.whatsapp.net", id: "21" }]);
    });

    it("handed_off status: adds HUMANO label, removes BOT label", async () => {
      await db.upsertLabel("BOT", "20", 4);
      await db.upsertLabel("HUMANO", "21", 5);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.applyStatus("5215551234567", "handed_off", runtime);

      expect(runtime.addedLabels).toEqual([{ jid: "525551234567@s.whatsapp.net", id: "21" }]);
      expect(runtime.removedLabels).toEqual([{ jid: "525551234567@s.whatsapp.net", id: "20" }]);
    });
  });

  describe("syncAll", () => {
    it("applies both score and status labels", async () => {
      await db.upsertLabel("HOT", "10", 0);
      await db.upsertLabel("WARM", "11", 3);
      await db.upsertLabel("COLD", "12", 7);
      await db.upsertLabel("OUT", "13", 14);
      await db.upsertLabel("BOT", "20", 4);
      await db.upsertLabel("HUMANO", "21", 5);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.syncAll("5215551234567", "WARM", "qualifying", runtime);

      const addedIds = runtime.addedLabels.map((a) => a.id);
      expect(addedIds).toContain("11"); // WARM score
      expect(addedIds).toContain("20"); // BOT status
    });

    it("removes score labels when score is null", async () => {
      await db.upsertLabel("HOT", "10", 0);
      await db.upsertLabel("WARM", "11", 3);
      await db.upsertLabel("COLD", "12", 7);
      await db.upsertLabel("OUT", "13", 14);
      await db.upsertLabel("BOT", "20", 4);
      await db.upsertLabel("HUMANO", "21", 5);
      const runtime = fakeRuntime();
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.syncAll("5215551234567", null, "qualifying", runtime);

      // Should try to remove all score labels
      const removedIds = runtime.removedLabels.map((r) => r.id);
      expect(removedIds).toContain("10");
      expect(removedIds).toContain("11");
      expect(removedIds).toContain("12");
      expect(removedIds).toContain("13");
    });
  });

  describe("ensureLabels", () => {
    it("pre-warms all configured labels", async () => {
      const runtime = fakeRuntime([
        { id: "10", name: "HOT", color: 0, deleted: false },
        { id: "11", name: "WARM", color: 3, deleted: false },
        { id: "12", name: "COLD", color: 7, deleted: false },
        { id: "13", name: "OUT", color: 14, deleted: false },
        { id: "20", name: "BOT", color: 4, deleted: false },
        { id: "21", name: "HUMANO", color: 5, deleted: false },
      ]);
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      await svc.ensureLabels(runtime);

      // All labels should be persisted in DB
      const allLabels = await db.getAllLabels();
      expect(allLabels).toHaveLength(6);
      const names = allLabels.map((l) => l.name).sort();
      expect(names).toEqual(["BOT", "COLD", "HOT", "HUMANO", "OUT", "WARM"]);
    });
  });

  describe("graceful degradation", () => {
    it("no-ops when getLabels/createLabel unavailable", async () => {
      const runtime: Runtime = {
        async sendMessage() {},
        // No getLabels, no createLabel, no addChatLabel, no removeChatLabel
      };
      const svc = new WhatsAppLabelService(defaultConfig, db, 0);

      // Should not throw
      await svc.applyScore("5215551234567", "HOT", runtime);
      await svc.applyStatus("5215551234567", "qualifying", runtime);
      await svc.syncAll("5215551234567", "HOT", "qualifying", runtime);
    });
  });
});
