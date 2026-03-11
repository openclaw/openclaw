export interface TypeDBConfig {
  host: string;
  port: number;
  database: string;
}

export interface TypeDBClient {
  config: TypeDBConfig;
  query: (typeql: string) => Promise<unknown[]>;
  insertEntity: (type: string, attrs: Record<string, unknown>) => Promise<void>;
  insertRelation: (
    relationType: string,
    ...roles: Array<{ role: string; entityType: string; id: string }>
  ) => Promise<void>;
  deleteEntity: (type: string, keyAttr: string, keyValue: string) => Promise<void>;
  close: () => Promise<void>;
}

export function getTypeDBConfig(): TypeDBConfig {
  return {
    host: process.env.MABOS_TYPEDB_HOST ?? "localhost",
    port: parseInt(process.env.MABOS_TYPEDB_PORT ?? "1729", 10),
    database: process.env.MABOS_TYPEDB_DATABASE ?? "mabos_knowledge",
  };
}

export async function createTypeDBClient(config?: TypeDBConfig): Promise<TypeDBClient> {
  const cfg = config ?? getTypeDBConfig();
  const { TypeDB } = await import("typedb-driver");
  const driver = await TypeDB.coreDriver(`${cfg.host}:${cfg.port}`);

  const client: TypeDBClient = {
    config: cfg,

    async query(typeql: string): Promise<unknown[]> {
      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("read");
        try {
          const results: unknown[] = [];
          const stream = tx.query.get(typeql);
          for await (const row of stream) {
            results.push(row);
          }
          return results;
        } finally {
          await tx.close();
        }
      } finally {
        await session.close();
      }
    },

    async insertEntity(type: string, attrs: Record<string, unknown>): Promise<void> {
      const attrClauses = Object.entries(attrs)
        .map(([k, v]) => {
          const val = typeof v === "string" ? `"${v}"` : v;
          return `has ${k} ${val}`;
        })
        .join(", ");
      const typeql = `insert $e isa ${type}, ${attrClauses};`;
      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("write");
        try {
          await tx.query.insert(typeql);
          await tx.commit();
        } catch (err) {
          await tx.close();
          throw err;
        }
      } finally {
        await session.close();
      }
    },

    async insertRelation(
      relationType: string,
      ...roles: Array<{ role: string; entityType: string; id: string }>
    ): Promise<void> {
      const matchClauses = roles
        .map((r, i) => {
          const keyAttr = `${r.entityType}-id`;
          return `$r${i} isa ${r.entityType}, has ${keyAttr} "${r.id}"`;
        })
        .join("; ");
      const roleClauses = roles.map((r, i) => `${r.role}: $r${i}`).join(", ");
      const typeql = `match ${matchClauses}; insert (${roleClauses}) isa ${relationType};`;
      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("write");
        try {
          await tx.query.insert(typeql);
          await tx.commit();
        } catch (err) {
          await tx.close();
          throw err;
        }
      } finally {
        await session.close();
      }
    },

    async deleteEntity(type: string, keyAttr: string, keyValue: string): Promise<void> {
      const typeql = `match $e isa ${type}, has ${keyAttr} "${keyValue}"; delete $e isa ${type};`;
      const session = await driver.session(cfg.database, "data");
      try {
        const tx = await session.transaction("write");
        try {
          await tx.query.delete(typeql);
          await tx.commit();
        } catch (err) {
          await tx.close();
          throw err;
        }
      } finally {
        await session.close();
      }
    },

    async close(): Promise<void> {
      await driver.close();
    },
  };

  return client;
}
