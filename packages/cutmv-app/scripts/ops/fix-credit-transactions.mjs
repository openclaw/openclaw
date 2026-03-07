// Drop and recreate credit_transactions table to match current schema
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
-- Drop old table if exists
DROP TABLE IF EXISTS credit_transactions CASCADE;

-- Recreate with correct schema matching shared/schema.ts
CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  referral_event_id UUID REFERENCES referral_events(id),
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_transactions_created_at ON credit_transactions(created_at DESC);
`;

try {
  console.log('🔧 Recreating credit_transactions table with correct schema...');
  await pool.query(sql);
  console.log('✅ credit_transactions table recreated successfully!');
  console.log('📊 Schema now matches shared/schema.ts with UUID columns');
} catch (error) {
  console.error('❌ Error recreating credit_transactions table:', error);
  process.exit(1);
} finally {
  await pool.end();
}
