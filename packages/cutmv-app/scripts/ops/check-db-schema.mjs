// Check actual database schema
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Checking referral_events table schema...');
  const referralEvents = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'referral_events'
    ORDER BY ordinal_position;
  `);
  console.log('referral_events columns:', referralEvents.rows);

  console.log('\n🔍 Checking credit_transactions table schema...');
  const creditTx = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'credit_transactions'
    ORDER BY ordinal_position;
  `);
  console.log('credit_transactions columns:', creditTx.rows);

  console.log('\n🔍 Checking users table ID type...');
  const users = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'id';
  `);
  console.log('users.id type:', users.rows);

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
