#!/usr/bin/env node
// Quick test script for the Supabase helper. Usage:
// SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/supabase_test.mjs <table> '{"col":"value"}'

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const helperPath = path.join(__dirname, '..', 'extensions', 'supabase', 'src', 'index.js');
const { insertRow, selectRows } = await import('file://' + helperPath);

function usage() {
  console.error('Usage: node scripts/supabase_test.mjs <table> [json-row]');
  process.exit(2);
}

const [,, table, rowJson] = process.argv;
if (!table) usage();
let row = { test_at: new Date().toISOString() };
if (rowJson) {
  try { row = JSON.parse(rowJson); } catch (e) { console.error('Invalid JSON for row'); process.exit(2); }
}

(async () => {
  try {
    console.log('Inserting row into', table);
    const out = await insertRow(table, row);
    console.log('Insert result:', out);
  } catch (err) {
    console.error('Insert failed:', err?.status ?? err.message, err?.body ?? err);
    console.log('Attempting select to show permissions...');
    try {
      const rows = await selectRows(table, { limit: 5, select: '*' });
      console.log('Select result:', rows);
    } catch (e) {
      console.error('Select also failed:', e?.status ?? e.message, e?.body ?? e);
    }
  }
})();
