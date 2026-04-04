import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: 'public' }
});

async function queryDirectSQL(query, description) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 ${description}`);
  console.log('='.repeat(60));

  const { data, error } = await supabase.rpc('exec', { sql: query });

  if (error) {
    // Try using REST API directly
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({ sql: query })
    });

    if (!response.ok) {
      console.log('❌ 無法執行 SQL，需要從 Supabase Dashboard 手動查詢\n');
      console.log('請在 Dashboard 執行：');
      console.log('```sql');
      console.log(query);
      console.log('```\n');
      return null;
    }

    const result = await response.json();
    console.log(result);
    return result;
  }

  console.log(data);
  return data;
}

async function main() {
  // Query 1: Check triggers
  await queryDirectSQL(
    `
    SELECT
      t.trigger_name,
      t.event_object_schema as schema,
      t.event_object_table as table_name,
      t.action_timing,
      t.event_manipulation as event,
      t.action_statement
    FROM information_schema.triggers t
    WHERE t.event_object_schema IN ('auth', 'public')
    ORDER BY t.event_object_schema, t.event_object_table, t.trigger_name;
    `,
    '查詢所有 Triggers'
  );

  // Query 2: Check functions
  await queryDirectSQL(
    `
    SELECT
      r.routine_name as function_name,
      r.routine_schema as schema,
      SUBSTRING(r.routine_definition, 1, 200) as definition_preview
    FROM information_schema.routines r
    WHERE r.routine_schema IN ('auth', 'public')
    AND r.routine_type = 'FUNCTION'
    AND (
      r.routine_name LIKE '%profile%' OR
      r.routine_name LIKE '%user%' OR
      r.routine_name LIKE '%handle%'
    )
    ORDER BY r.routine_name;
    `,
    '查詢相關 Functions'
  );

  // Query 3: Check all public functions
  await queryDirectSQL(
    `
    SELECT
      routine_name,
      routine_definition
    FROM information_schema.routines
    WHERE routine_schema = 'public'
    AND routine_type = 'FUNCTION'
    ORDER BY routine_name;
    `,
    '查詢所有 public schema Functions'
  );
}

main().catch(console.error);
