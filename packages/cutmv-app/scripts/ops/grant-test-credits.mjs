// Grant test credits to corey@securitywiz.net
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  // Get user
  const user = await pool.query(`
    SELECT id, email, credits
    FROM users
    WHERE email = 'corey@securitywiz.net';
  `);

  if (user.rows.length === 0) {
    console.error('User not found!');
    process.exit(1);
  }

  const userId = user.rows[0].id;
  console.log(`💰 Current credits for ${user.rows[0].email}: ${user.rows[0].credits}`);

  // Grant credits using CreditService logic
  const creditAmount = 500; // 500 credits = $5 worth

  console.log(`\n✨ Granting ${creditAmount} test credits...`);

  // Update user credits
  await pool.query(`
    UPDATE users
    SET credits = credits + $1
    WHERE id = $2;
  `, [creditAmount, userId]);

  // Record transaction
  await pool.query(`
    INSERT INTO credit_transactions (user_id, amount, transaction_type, note, created_at)
    VALUES ($1, $2, $3, $4, NOW());
  `, [userId, creditAmount, 'admin_grant', 'Test credits for verification']);

  console.log('✅ Credits granted successfully!');

  // Verify
  const updated = await pool.query(`
    SELECT credits FROM users WHERE id = $1;
  `, [userId]);

  console.log(`\n💎 New balance: ${updated.rows[0].credits} credits`);

  // Show transaction
  const tx = await pool.query(`
    SELECT * FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1;
  `, [userId]);

  console.log(`📊 Latest transaction:`, tx.rows[0]);

} catch (error) {
  console.error('Error:', error);
} finally {
  await pool.end();
}
