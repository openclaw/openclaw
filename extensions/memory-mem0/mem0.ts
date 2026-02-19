import path from 'node:path';
import fs from 'fs-extra';
import { Database, open } from 'sqlite';

export type MemoryLayer = 'session' | 'pref' | 'fact' | 'task';

export interface MemoryEntry {
  id?: number;
  layer: MemoryLayer;
  content: string;
  metadata: string; // JSON string
  timestamp: string;
  embedding?: Float32Array;
}

export class Mem0SQLite {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  public static async create(dbPath: string): Promise<Mem0SQLite> {
    await fs.ensureDir(path.dirname(dbPath));
    const db = await open({
      filename: dbPath,
      driver: (await import('sqlite3')).default.Database
    });
    await this.initSchema(db);
    return new Mem0SQLite(db);
  }

  private static async initSchema(db: Database) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        layer TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_layer ON memories(layer);
    `);

    try {
        const sqliteVec = await import("sqlite-vec");
        sqliteVec.load((db as any).driver);

        await db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
                id INTEGER PRIMARY KEY,
                embedding float[384]
            );
        `);
    } catch (err) {
        console.warn("sqlite-vec not available", err);
    }
  }

  async addMemory(layer: MemoryLayer, content: string, metadata: any = {}, embedding?: number[]): Promise<void> {
    // Auto-Archivist Hardening: Evitar duplicatas exatas na mesma camada
    const exists = await this.db.get('SELECT id FROM memories WHERE layer = ? AND content = ?', [layer, content]);
    if (exists) return;

    const result = await this.db.run(
      'INSERT INTO memories (layer, content, metadata, timestamp) VALUES (?, ?, ?, ?)',
      [layer, content, JSON.stringify(metadata), new Date().toISOString()]
    );

    if (embedding && result.lastID) {
        await this.db.run(
            'INSERT INTO vec_memories(id, embedding) VALUES (?, ?)',
            [result.lastID, new Float32Array(embedding)]
        );
    }
  }

  async getContext(budget: number = 1000): Promise<string> {
    const prefs = await this.db.all('SELECT content FROM memories WHERE layer = ? LIMIT 5', ['pref']);
    const facts = await this.db.all('SELECT content FROM memories WHERE layer = ? ORDER BY timestamp DESC LIMIT 10', ['fact']);
    const tasks = await this.db.all('SELECT content FROM memories WHERE layer = ? LIMIT 3', ['task']);
    const sessions = await this.db.all('SELECT content FROM memories WHERE layer = ? ORDER BY timestamp DESC LIMIT 1', ['session']);

    let context = "### MEM0 LONG-TERM CONTEXT\n";
    if (prefs.length) context += `Preferences: ${prefs.map(p => p.content).join('; ')}\n`;
    if (facts.length) context += `Key Facts: ${facts.map(f => f.content).join('; ')}\n`;
    if (tasks.length) context += `Active Tasks: ${tasks.map(t => t.content).join('; ')}\n`;
    if (sessions.length) context += `Last Summary: ${sessions[0].content}\n`;

    return context.substring(0, budget);
  }

  async updateSessionSummary(summary: string): Promise<void> {
    await this.addMemory('session', summary);
  }
}
