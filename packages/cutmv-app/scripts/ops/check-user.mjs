// Check user format
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('💰 Checking user...');
  const user = await pool.query(`
    SELECT id, email, credits, referral_count
    FROM users
    WHERE email = 'corey@securitywiz.net';
  `);
  console.log('User:', user.rows[0]);
  console.log('User ID type:', typeof user.rows[0]?.id);

  console.log('\n📊 Checking all credit transactions...');
  const transactions = await pool.query(`
    SELECT *
    FROM credit_transactions
    ORDER BY created_at DESC
    LIMIT 5;
  `);
  console.log(`Found ${transactions.rows.length} total transactions:`, transactions.rows);

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
