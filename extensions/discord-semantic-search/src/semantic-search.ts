import type { APIMessage } from "discord-api-types/v10";
import Database from "better-sqlite3";
import path from "node:path";

export interface DiscordSemanticSearchConfig {
  dbPath?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}

export interface IndexedMessage {
  id: string;
  channelId: string;
  guildId: string;
  authorId: string;
  content: string;
  timestamp: string;
  messageUrl: string;
  embedding?: Float32Array;
}

export interface SemanticSearchResult {
  message: IndexedMessage;
  similarity: number;
}

export interface SemanticSearchQuery {
  query: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
  minSimilarity?: number;
  after?: string;
  before?: string;
}

export class DiscordSemanticSearch {
  private db: Database.Database;
  private config: DiscordSemanticSearchConfig;

  constructor(config: DiscordSemanticSearchConfig = {}) {
    this.config = {
      dbPath: config.dbPath || path.join(process.cwd(), "data", "discord-search.db"),
      embeddingModel: config.embeddingModel || "text-embedding-3-small",
      embeddingDimensions: config.embeddingDimensions || 1536,
      ...config,
    };

    this.db = new Database(this.config.dbPath);
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    try {
      // Enable sqlite-vec extension
      this.db.loadExtension("sqlite-vec");
    } catch (error) {
      console.warn("Failed to load sqlite-vec extension:", error);
      console.warn("Vector search will not be available, falling back to text search");
    }

    // Create messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        message_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create vector table for embeddings (only if sqlite-vec is available)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(
          message_id TEXT PRIMARY KEY,
          embedding FLOAT[${this.config.embeddingDimensions}]
        )
      `);
    } catch (error) {
      console.warn("Failed to create vector table:", error);
    }

    // Create indexes for better performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON discord_messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_author ON discord_messages(author_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON discord_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_guild ON discord_messages(guild_id);
    `);
  }

  testConnection(): { database: boolean; vector: boolean } {
    try {
      // Test basic database
      const dbTest = this.db.prepare("SELECT 1 as test").get() as { test: number };
      const databaseOk = dbTest.test === 1;

      // Test vector capabilities
      let vectorOk = false;
      try {
        this.db.prepare("SELECT vec_version()").get();
        vectorOk = true;
      } catch {
        vectorOk = false;
      }

      return { database: databaseOk, vector: vectorOk };
    } catch (error) {
      console.error("Database connection test failed:", error);
      return { database: false, vector: false };
    }
  }

  async indexMessage(message: APIMessage, guildId: string): Promise<void> {
    // Skip messages without content or from bots
    if (!message.content?.trim() || message.author.bot) {
      return;
    }

    const messageUrl = `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;

    const indexedMessage: IndexedMessage = {
      id: message.id,
      channelId: message.channel_id,
      guildId,
      authorId: message.author.id,
      content: message.content,
      timestamp: message.timestamp,
      messageUrl,
    };

    // Check if message already exists
    const existing = this.db
      .prepare("SELECT id FROM discord_messages WHERE id = ?")
      .get(message.id);
    if (existing) {
      return; // Skip if already indexed
    }

    // Insert message
    const insertMessage = this.db.prepare(`
      INSERT INTO discord_messages (id, channel_id, guild_id, author_id, content, timestamp, message_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertMessage.run(
      indexedMessage.id,
      indexedMessage.channelId,
      indexedMessage.guildId,
      indexedMessage.authorId,
      indexedMessage.content,
      indexedMessage.timestamp,
      indexedMessage.messageUrl,
    );

    // Generate and store embedding
    try {
      const embedding = await this.generateEmbedding(message.content);
      if (embedding) {
        this.storeEmbedding(message.id, embedding);
      }
    } catch (error) {
      console.warn(`Failed to generate embedding for message ${message.id}:`, error);
    }
  }

  private async generateEmbedding(text: string): Promise<Float32Array | null> {
    try {
      // Use OpenAI text-embedding-3-small model for embeddings
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          input: text.trim(),
          model: this.config.embeddingModel,
          dimensions: this.config.embeddingDimensions,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (!data.data?.[0]?.embedding) {
        throw new Error("No embedding returned from OpenAI API");
      }

      return new Float32Array(data.data[0].embedding);
    } catch (error) {
      console.error("Failed to generate embedding:", error);
      return null;
    }
  }

  private storeEmbedding(messageId: string, embedding: Float32Array): void {
    const insertEmbedding = this.db.prepare(`
      INSERT OR REPLACE INTO message_embeddings (message_id, embedding)
      VALUES (?, ?)
    `);

    insertEmbedding.run(messageId, embedding);
  }

  async search(query: SemanticSearchQuery): Promise<SemanticSearchResult[]> {
    // Generate embedding for the search query
    const queryEmbedding = await this.generateEmbedding(query.query);
    if (!queryEmbedding) {
      // Fallback to text-based search if embedding generation fails
      return this.textSearch(query);
    }

    // Build the SQL query with filters
    let sql = `
      SELECT 
        m.id, m.channel_id, m.guild_id, m.author_id, 
        m.content, m.timestamp, m.message_url,
        vec_distance_cosine(e.embedding, ?) as distance
      FROM discord_messages m
      JOIN message_embeddings e ON m.id = e.message_id
      WHERE 1=1
    `;

    const params: any[] = [queryEmbedding];

    if (query.channelIds?.length) {
      sql += ` AND m.channel_id IN (${query.channelIds.map(() => "?").join(",")})`;
      params.push(...query.channelIds);
    }

    if (query.authorIds?.length) {
      sql += ` AND m.author_id IN (${query.authorIds.map(() => "?").join(",")})`;
      params.push(...query.authorIds);
    }

    if (query.after) {
      sql += ` AND m.timestamp > ?`;
      params.push(query.after);
    }

    if (query.before) {
      sql += ` AND m.timestamp < ?`;
      params.push(query.before);
    }

    // Order by similarity (lower distance = higher similarity)
    sql += ` ORDER BY distance ASC`;

    if (query.limit) {
      sql += ` LIMIT ?`;
      params.push(query.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(params) as any[];

    return rows
      .map((row) => ({
        message: {
          id: row.id,
          channelId: row.channel_id,
          guildId: row.guild_id,
          authorId: row.author_id,
          content: row.content,
          timestamp: row.timestamp,
          messageUrl: row.message_url,
        } as IndexedMessage,
        similarity: 1 - row.distance, // Convert distance to similarity
      }))
      .filter((result) => !query.minSimilarity || result.similarity >= query.minSimilarity);
  }

  private textSearch(query: SemanticSearchQuery): SemanticSearchResult[] {
    // Fallback text-based search using SQLite FTS
    let sql = `
      SELECT id, channel_id, guild_id, author_id, content, timestamp, message_url
      FROM discord_messages
      WHERE content LIKE ?
    `;

    const params: any[] = [`%${query.query}%`];

    if (query.channelIds?.length) {
      sql += ` AND channel_id IN (${query.channelIds.map(() => "?").join(",")})`;
      params.push(...query.channelIds);
    }

    if (query.authorIds?.length) {
      sql += ` AND author_id IN (${query.authorIds.map(() => "?").join(",")})`;
      params.push(...query.authorIds);
    }

    if (query.after) {
      sql += ` AND timestamp > ?`;
      params.push(query.after);
    }

    if (query.before) {
      sql += ` AND timestamp < ?`;
      params.push(query.before);
    }

    sql += ` ORDER BY timestamp DESC`;

    if (query.limit) {
      sql += ` LIMIT ?`;
      params.push(query.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(params) as any[];

    return rows.map((row) => ({
      message: {
        id: row.id,
        channelId: row.channel_id,
        guildId: row.guild_id,
        authorId: row.author_id,
        content: row.content,
        timestamp: row.timestamp,
        messageUrl: row.message_url,
      } as IndexedMessage,
      similarity: 0.5, // Default similarity for text search
    }));
  }

  async indexMessagesFromResults(
    messages: APIMessage[],
    guildId: string,
  ): Promise<{ indexed: number; skipped: number; errors: number }> {
    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    for (const message of messages) {
      try {
        await this.indexMessage(message, guildId);
        indexed++;
      } catch (error) {
        if (error instanceof Error && error.message.includes("already indexed")) {
          skipped++;
        } else {
          errors++;
          console.warn(`Failed to index message ${message.id}:`, error);
        }
      }
    }

    return { indexed, skipped, errors };
  }

  async reindexWithEmbeddings(): Promise<{ processed: number; updated: number; errors: number }> {
    // Get messages that don't have embeddings yet
    const messagesWithoutEmbeddings = this.db
      .prepare(`
      SELECT id, content FROM discord_messages
      WHERE id NOT IN (SELECT message_id FROM message_embeddings)
      LIMIT 100
    `)
      .all() as { id: string; content: string }[];

    let processed = 0;
    let updated = 0;
    let errors = 0;

    for (const message of messagesWithoutEmbeddings) {
      try {
        const embedding = await this.generateEmbedding(message.content);
        if (embedding) {
          this.storeEmbedding(message.id, embedding);
          updated++;
        }
        processed++;
      } catch (error) {
        errors++;
        console.warn(`Failed to generate embedding for message ${message.id}:`, error);
      }
    }

    return { processed, updated, errors };
  }

  getStats(): { totalMessages: number; totalEmbeddings: number } {
    const totalMessages = this.db
      .prepare("SELECT COUNT(*) as count FROM discord_messages")
      .get() as { count: number };
    const totalEmbeddings = this.db
      .prepare("SELECT COUNT(*) as count FROM message_embeddings")
      .get() as { count: number };

    return {
      totalMessages: totalMessages.count,
      totalEmbeddings: totalEmbeddings.count,
    };
  }

  close(): void {
    this.db.close();
  }
}
