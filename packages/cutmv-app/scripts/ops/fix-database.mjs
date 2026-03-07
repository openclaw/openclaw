// Temporary script to add missing database column
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

// Load .env file
config();

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
-- Add r2_download_url column to background_jobs table if it doesn't exist
ALTER TABLE background_jobs
ADD COLUMN IF NOT EXISTS r2_download_url TEXT;
`;

try {
  console.log('🔧 Adding missing r2_download_url column...');
  await pool.query(sql);
  console.log('✅ Database schema updated successfully!');
} catch (error) {
  console.error('❌ Error updating database:', error);
  process.exit(1);
} finally {
  await pool.end();
}
