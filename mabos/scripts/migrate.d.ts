#!/usr/bin/env node
/**
 * MABOS Migration Script
 *
 * Migrates data from ~/.openclaw/ to ~/.mabos/
 * Invoked via: mabos migrate
 *
 * Steps:
 *  1. Detect ~/.openclaw/ directory
 *  2. Create ~/.mabos/ if it doesn't exist
 *  3. Copy workspace data (businesses, agents, memory, credentials)
 *  4. Translate openclaw.json → mabos.json (rename config keys)
 *  5. Print summary
 */
interface MigrationResult {
  success: boolean;
  sourceDir: string;
  targetDir: string;
  itemsCopied: string[];
  configMigrated: boolean;
  errors: string[];
}
export declare function migrate(opts?: { dryRun?: boolean }): Promise<MigrationResult>;

//# sourceMappingURL=migrate.d.ts.map
