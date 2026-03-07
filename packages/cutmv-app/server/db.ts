import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Validate DATABASE_URL format for security
function validateDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
  } catch {
    return false;
  }
}

if (!validateDatabaseUrl(process.env.DATABASE_URL)) {
  throw new Error(
    "DATABASE_URL must be a valid PostgreSQL connection string",
  );
}

// Configure connection pool with better error handling and reconnection
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 10, // Maximum number of connections
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 2000, // Wait 2 seconds for new connection
});

// Add connection error handling
pool.on('error', (err) => {
  console.error('Database pool error:', err);
});

export const db = drizzle({ client: pool, schema });
