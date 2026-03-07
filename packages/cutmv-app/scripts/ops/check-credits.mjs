// Check credit transactions and user credits
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Checking credit_transactions table...');
  const txSchema = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'credit_transactions'
    ORDER BY ordinal_position;
  `);
  console.log('Columns:', txSchema.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));

  console.log('\n📊 Checking transactions for corey@securitywiz.net...');
  const transactions = await pool.query(`
    SELECT ct.*, u.email
    FROM credit_transactions ct
    JOIN users u ON u.id = ct.user_id
    WHERE u.email = 'corey@securitywiz.net'
    ORDER BY ct.created_at DESC
    LIMIT 10;
  `);
  console.log(`Found ${transactions.rows.length} transactions:`, transactions.rows);

  console.log('\n💰 Checking user credits...');
  const user = await pool.query(`
    SELECT id, email, credits, referral_count
    FROM users
    WHERE email = 'corey@securitywiz.net';
  `);
  console.log('User:', user.rows[0]);

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
