// Check download_tokens table schema
import { config } from 'dotenv';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { neonConfig } from '@neondatabase/serverless';

config();
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  console.log('🔍 Checking download_tokens table schema...\n');

  const schema = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'download_tokens'
    ORDER BY ordinal_position;
  `);

  console.log('Download tokens columns:');
  schema.rows.forEach(col => {
    console.log(`  - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'nullable' : 'required'})`);
  });

  console.log('\n📊 Checking recent tokens...\n');

  const tokens = await pool.query(`
    SELECT * FROM download_tokens
    WHERE user_email = 'corey@securitywiz.net'
    ORDER BY created_at DESC
    LIMIT 1;
  `);

  if (tokens.rows.length > 0) {
    console.log('Latest token data:');
    console.log(JSON.stringify(tokens.rows[0], null, 2));
  } else {
    console.log('No tokens found for corey@securitywiz.net');
  }

} catch (error) {
  console.error('Error:', error.message);
} finally {
  await pool.end();
}
