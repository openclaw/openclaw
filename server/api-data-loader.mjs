// Utility to load JSON data files from ../data
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data');

export function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8'));
}

export const az_accounts = loadJson('az_accounts.json');
export const az_units = loadJson('az_units.json');
export const az_work_orders = loadJson('az_work_orders.json');
export const az_violations = loadJson('az_violations.json');
// Add more as needed
