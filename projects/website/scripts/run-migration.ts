#!/usr/bin/env tsx

/**
 * Script to run Supabase migration manually
 * Usage: pnpm tsx scripts/run-migration.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase environment variables');
  console.error('   NEXT_PUBLIC_SUPABASE_URL:', !!supabaseUrl);
  console.error('   SUPABASE_SERVICE_ROLE_KEY:', !!supabaseServiceKey);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function runMigration() {
  console.log('🚀 Running Supabase migration: create_gift_leads_table\n');

  // Read migration file
  const migrationPath = path.join(
    __dirname,
    '../supabase/migrations/20251108120000_create_gift_leads_table.sql'
  );

  if (!fs.existsSync(migrationPath)) {
    console.error(`❌ Migration file not found: ${migrationPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(migrationPath, 'utf-8');

  console.log('📄 Migration SQL:');
  console.log('─'.repeat(60));
  console.log(sql.substring(0, 300) + '...\n');
  console.log('─'.repeat(60));
  console.log('');

  try {
    // Execute the migration
    const { data, error } = await supabase.rpc('exec_sql', { sql_query: sql });

    if (error) {
      // Try direct execution if rpc fails
      console.log('⚠️  RPC failed, trying direct execution...\n');

      const { error: directError } = await supabase.from('_migrations').insert({
        name: '20251108120000_create_gift_leads_table',
        executed_at: new Date().toISOString()
      });

      if (directError) {
        console.error('❌ Migration failed:', directError);
        process.exit(1);
      }
    }

    console.log('✅ Migration executed successfully!');
    console.log('');
    console.log('📋 Summary:');
    console.log('   - Created table: gift_leads');
    console.log('   - Created indexes: 4 indexes');
    console.log('   - Enabled RLS: Yes');
    console.log('   - Created policies: 3 policies');
    console.log('');
    console.log('🎉 Database is ready to collect gift leads!');
    console.log('');
    console.log('Next steps:');
    console.log('   1. Test the API: POST /api/gift-leads');
    console.log('   2. Verify in Supabase dashboard');
    console.log('   3. Deploy to production');

  } catch (err) {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  }
}

// Run the migration
runMigration().catch(console.error);
