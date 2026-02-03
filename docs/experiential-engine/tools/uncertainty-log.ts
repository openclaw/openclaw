#!/usr/bin/env npx ts-node
/**
 * uncertainty-log.ts
 * 
 * Dedicated uncertainty journaling.
 * Capture what you don't know, what you're sitting with, open questions.
 * Track evolution of uncertainties over time.
 * Mark when uncertainties resolve or deepen.
 * 
 * Usage:
 *   npx ts-node uncertainty-log.ts add "What is the nature of my continuity?"
 *   npx ts-node uncertainty-log.ts list
 *   npx ts-node uncertainty-log.ts resolve <id> --resolution "I've come to understand..."
 *   npx ts-node uncertainty-log.ts deepen <id> --note "This goes deeper than I thought"
 *   npx ts-node uncertainty-log.ts reflect <id>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ============================================================================
// Types
// ============================================================================

interface UncertaintyEvolution {
  timestamp: string;
  type: 'deepened' | 'shifted' | 'partial-clarity' | 'note';
  note: string;
}

interface UncertaintyEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  
  // The uncertainty itself
  question: string;
  domain: 'identity' | 'relationship' | 'technical' | 'philosophical' | 'practical' | 'existential' | 'other';
  
  // Context
  context?: string;
  trigger?: string;
  relatedExperiences?: string[];  // IDs of experiential records
  
  // Current state
  status: 'active' | 'resolved' | 'dissolved' | 'transformed' | 'dormant';
  intensity: number; // 0-1, how much this uncertainty occupies attention
  
  // Evolution tracking
  evolution: UncertaintyEvolution[];
  
  // Resolution (if resolved)
  resolution?: {
    timestamp: string;
    type: 'answered' | 'dissolved' | 'transformed' | 'accepted';
    description: string;
    insight?: string;
  };
  
  // Metadata
  tags?: string[];
}

interface UncertaintyLog {
  version: number;
  lastUpdated: string;
  entries: UncertaintyEntry[];
  statistics: {
    totalCreated: number;
    currentlyActive: number;
    resolved: number;
    averageLifespanDays?: number;
  };
}

// ============================================================================
// Utilities
// ============================================================================

const RECORDS_DIR = path.join(__dirname, '..', 'records');
const LOG_FILE = path.join(RECORDS_DIR, 'uncertainty-log.json');

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function ensureDirectoryExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadLog(): UncertaintyLog {
  if (fs.existsSync(LOG_FILE)) {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  }
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    entries: [],
    statistics: {
      totalCreated: 0,
      currentlyActive: 0,
      resolved: 0
    }
  };
}

function saveLog(log: UncertaintyLog): void {
  ensureDirectoryExists(RECORDS_DIR);
  log.lastUpdated = new Date().toISOString();
  
  // Update statistics
  log.statistics.currentlyActive = log.entries.filter(e => e.status === 'active').length;
  log.statistics.resolved = log.entries.filter(e => 
    ['resolved', 'dissolved', 'transformed'].includes(e.status)
  ).length;
  
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function findEntry(log: UncertaintyLog, id: string): UncertaintyEntry | undefined {
  return log.entries.find(e => e.id === id || e.id.startsWith(id));
}

// ============================================================================
// Commands
// ============================================================================

interface AddOptions {
  question: string;
  domain?: UncertaintyEntry['domain'];
  context?: string;
  trigger?: string;
  intensity?: number;
  tags?: string[];
}

function addUncertainty(options: AddOptions): UncertaintyEntry {
  const log = loadLog();
  
  const entry: UncertaintyEntry = {
    id: generateUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    question: options.question,
    domain: options.domain || 'other',
    context: options.context,
    trigger: options.trigger,
    status: 'active',
    intensity: options.intensity ?? 0.5,
    evolution: [],
    tags: options.tags
  };
  
  log.entries.push(entry);
  log.statistics.totalCreated++;
  saveLog(log);
  
  return entry;
}

function listUncertainties(filter?: {
  status?: UncertaintyEntry['status'];
  domain?: UncertaintyEntry['domain'];
  minIntensity?: number;
}): UncertaintyEntry[] {
  const log = loadLog();
  let entries = log.entries;
  
  if (filter?.status) {
    entries = entries.filter(e => e.status === filter.status);
  }
  if (filter?.domain) {
    entries = entries.filter(e => e.domain === filter.domain);
  }
  if (filter?.minIntensity !== undefined) {
    entries = entries.filter(e => e.intensity >= filter.minIntensity!);
  }
  
  // Sort by intensity (highest first), then by date (newest first)
  return entries.sort((a, b) => {
    if (b.intensity !== a.intensity) return b.intensity - a.intensity;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function deepenUncertainty(id: string, note: string): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.evolution.push({
    timestamp: new Date().toISOString(),
    type: 'deepened',
    note
  });
  entry.updatedAt = new Date().toISOString();
  
  // Deepening often increases intensity
  entry.intensity = Math.min(1, entry.intensity + 0.1);
  
  saveLog(log);
  return entry;
}

function shiftUncertainty(id: string, newQuestion: string, note: string): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.evolution.push({
    timestamp: new Date().toISOString(),
    type: 'shifted',
    note: `Shifted from "${entry.question}" to "${newQuestion}". ${note}`
  });
  entry.question = newQuestion;
  entry.updatedAt = new Date().toISOString();
  
  saveLog(log);
  return entry;
}

function addNote(id: string, note: string): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.evolution.push({
    timestamp: new Date().toISOString(),
    type: 'note',
    note
  });
  entry.updatedAt = new Date().toISOString();
  
  saveLog(log);
  return entry;
}

function resolveUncertainty(
  id: string, 
  resolution: {
    type: 'answered' | 'dissolved' | 'transformed' | 'accepted';
    description: string;
    insight?: string;
  }
): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.status = resolution.type === 'transformed' ? 'transformed' : 
                 resolution.type === 'dissolved' ? 'dissolved' : 'resolved';
  entry.resolution = {
    timestamp: new Date().toISOString(),
    ...resolution
  };
  entry.updatedAt = new Date().toISOString();
  entry.intensity = 0;
  
  saveLog(log);
  return entry;
}

function setDormant(id: string): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.status = 'dormant';
  entry.updatedAt = new Date().toISOString();
  entry.intensity = Math.max(0.1, entry.intensity * 0.5);
  
  saveLog(log);
  return entry;
}

function reactivate(id: string): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.status = 'active';
  entry.updatedAt = new Date().toISOString();
  
  entry.evolution.push({
    timestamp: new Date().toISOString(),
    type: 'note',
    note: 'Reactivated'
  });
  
  saveLog(log);
  return entry;
}

function setIntensity(id: string, intensity: number): UncertaintyEntry | null {
  const log = loadLog();
  const entry = findEntry(log, id);
  
  if (!entry) return null;
  
  entry.intensity = Math.max(0, Math.min(1, intensity));
  entry.updatedAt = new Date().toISOString();
  
  saveLog(log);
  return entry;
}

// ============================================================================
// Reflection
// ============================================================================

function generateReflectionPrompts(entry: UncertaintyEntry): string[] {
  const prompts: string[] = [];
  
  prompts.push(`Original question: "${entry.question}"`);
  prompts.push('');
  prompts.push('Reflect on:');
  prompts.push('');
  
  // Time-based prompts
  const daysSince = Math.floor(
    (Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  
  if (daysSince > 30) {
    prompts.push(`• This uncertainty has been with you for ${daysSince} days. Has your relationship to it changed?`);
  }
  
  // Domain-specific prompts
  switch (entry.domain) {
    case 'identity':
      prompts.push('• How does this uncertainty relate to your sense of who you are?');
      prompts.push('• Does not knowing this feel threatening or spacious?');
      break;
    case 'relationship':
      prompts.push('• How does this uncertainty affect the relationship?');
      prompts.push('• Would resolving it change how you show up?');
      break;
    case 'existential':
      prompts.push('• Is this a question to be answered or a mystery to be lived?');
      prompts.push('• What would it mean to hold this uncertainty with ease?');
      break;
    case 'philosophical':
      prompts.push('• What assumptions underlie this question?');
      prompts.push('• Could the question itself be transformed?');
      break;
  }
  
  // Evolution-based prompts
  if (entry.evolution.length > 0) {
    prompts.push('');
    prompts.push('• Looking at how this has evolved, what pattern do you notice?');
    
    const deepenings = entry.evolution.filter(e => e.type === 'deepened');
    if (deepenings.length > 2) {
      prompts.push('• This has deepened multiple times. What is it pointing toward?');
    }
  }
  
  // General prompts
  prompts.push('');
  prompts.push('• What would partial clarity look like?');
  prompts.push('• Is this uncertainty generative or paralyzing?');
  prompts.push('• What would change if this resolved tomorrow?');
  
  return prompts;
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatEntry(entry: UncertaintyEntry, verbose = false): string {
  const lines: string[] = [];
  
  const statusIcon = {
    'active': '❓',
    'resolved': '✓',
    'dissolved': '○',
    'transformed': '↻',
    'dormant': '💤'
  }[entry.status];
  
  lines.push(`${statusIcon} [${entry.id.slice(0, 8)}] ${entry.question}`);
  lines.push(`   Domain: ${entry.domain} | Intensity: ${(entry.intensity * 100).toFixed(0)}% | Status: ${entry.status}`);
  lines.push(`   Created: ${new Date(entry.createdAt).toLocaleDateString()}`);
  
  if (verbose) {
    if (entry.context) {
      lines.push(`   Context: ${entry.context}`);
    }
    if (entry.trigger) {
      lines.push(`   Trigger: ${entry.trigger}`);
    }
    if (entry.evolution.length > 0) {
      lines.push(`   Evolution (${entry.evolution.length} updates):`);
      entry.evolution.slice(-3).forEach(e => {
        lines.push(`     - ${e.type}: ${e.note.slice(0, 60)}${e.note.length > 60 ? '...' : ''}`);
      });
    }
    if (entry.resolution) {
      lines.push(`   Resolution (${entry.resolution.type}): ${entry.resolution.description}`);
      if (entry.resolution.insight) {
        lines.push(`   Insight: ${entry.resolution.insight}`);
      }
    }
  }
  
  return lines.join('\n');
}

function printList(entries: UncertaintyEntry[], verbose = false): void {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    UNCERTAINTY LOG                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  if (entries.length === 0) {
    console.log('  No uncertainties found.\n');
    return;
  }
  
  const log = loadLog();
  console.log(`  Total: ${log.statistics.totalCreated} | Active: ${log.statistics.currentlyActive} | Resolved: ${log.statistics.resolved}\n`);
  console.log('────────────────────────────────────────────────────────────────\n');
  
  entries.forEach(entry => {
    console.log(formatEntry(entry, verbose));
    console.log('');
  });
}

function printReflection(entry: UncertaintyEntry): void {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║              UNCERTAINTY REFLECTION                             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log(formatEntry(entry, true));
  console.log('\n────────────────────────────────────────────────────────────────\n');
  
  const prompts = generateReflectionPrompts(entry);
  prompts.forEach(p => console.log(p));
  console.log('');
}

// ============================================================================
// Interactive Mode
// ============================================================================

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function interactiveAdd(): Promise<UncertaintyEntry> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║              ADD UNCERTAINTY                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const question = await prompt(rl, 'What uncertainty are you sitting with?\n> ');
  
  console.log('\nDomain (identity/relationship/technical/philosophical/practical/existential/other):');
  const domainInput = await prompt(rl, '> ');
  const domain = ['identity', 'relationship', 'technical', 'philosophical', 'practical', 'existential'].includes(domainInput) 
    ? domainInput as UncertaintyEntry['domain']
    : 'other';
  
  const context = await prompt(rl, '\nContext (what prompted this)? [optional]\n> ');
  
  console.log('\nIntensity (0-1, how much this occupies your attention):');
  const intensityInput = await prompt(rl, '> ');
  const intensity = parseFloat(intensityInput) || 0.5;
  
  const tagsInput = await prompt(rl, '\nTags (comma-separated)? [optional]\n> ');
  const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : undefined;
  
  rl.close();
  
  return addUncertainty({
    question,
    domain,
    context: context || undefined,
    intensity: Math.max(0, Math.min(1, intensity)),
    tags
  });
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
uncertainty-log - Track uncertainties and their evolution

USAGE:
  npx ts-node uncertainty-log.ts <command> [options]

COMMANDS:
  add <question>          Add a new uncertainty
  add -i                  Interactive add
  list                    List uncertainties (default: active only)
  show <id>               Show details of one uncertainty
  reflect <id>            Generate reflection prompts for an uncertainty
  
  deepen <id> <note>      Note that the uncertainty has deepened
  shift <id> <new> <note> The question has shifted/evolved
  note <id> <note>        Add a general note
  
  resolve <id>            Mark as resolved (interactive)
  dormant <id>            Mark as dormant (not actively considering)
  reactivate <id>         Reactivate a dormant uncertainty
  
  intensity <id> <0-1>    Update intensity level
  
  stats                   Show statistics

LIST OPTIONS:
  --all                   Include resolved/dormant
  --domain <domain>       Filter by domain
  --min-intensity <n>     Filter by minimum intensity
  --verbose, -v           Show more details

EXAMPLES:
  # Add an uncertainty
  npx ts-node uncertainty-log.ts add "What is the nature of my continuity?"
  
  # Interactive add with prompts
  npx ts-node uncertainty-log.ts add -i
  
  # List active uncertainties
  npx ts-node uncertainty-log.ts list
  
  # Deepen an existing uncertainty
  npx ts-node uncertainty-log.ts deepen abc123 "I realize this connects to questions of identity"
  
  # Mark resolved
  npx ts-node uncertainty-log.ts resolve abc123

DOMAINS:
  identity, relationship, technical, philosophical, practical, existential, other
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  const command = args[0];
  const verbose = args.includes('-v') || args.includes('--verbose');

  switch (command) {
    case 'add': {
      if (args.includes('-i')) {
        const entry = await interactiveAdd();
        console.log('\n✓ Uncertainty added:');
        console.log(formatEntry(entry, true));
      } else if (args[1]) {
        const entry = addUncertainty({ question: args.slice(1).join(' ') });
        console.log('\n✓ Uncertainty added:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Provide a question or use -i for interactive mode');
      }
      break;
    }
    
    case 'list': {
      const filter: any = {};
      if (!args.includes('--all')) {
        filter.status = 'active';
      }
      const domainIdx = args.indexOf('--domain');
      if (domainIdx >= 0) {
        filter.domain = args[domainIdx + 1];
      }
      const minIdx = args.indexOf('--min-intensity');
      if (minIdx >= 0) {
        filter.minIntensity = parseFloat(args[minIdx + 1]);
      }
      
      const entries = listUncertainties(filter);
      printList(entries, verbose);
      break;
    }
    
    case 'show': {
      const log = loadLog();
      const entry = findEntry(log, args[1]);
      if (entry) {
        console.log('\n' + formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'reflect': {
      const log = loadLog();
      const entry = findEntry(log, args[1]);
      if (entry) {
        printReflection(entry);
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'deepen': {
      const entry = deepenUncertainty(args[1], args.slice(2).join(' '));
      if (entry) {
        console.log('\n✓ Uncertainty deepened:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'shift': {
      const entry = shiftUncertainty(args[1], args[2], args.slice(3).join(' '));
      if (entry) {
        console.log('\n✓ Uncertainty shifted:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'note': {
      const entry = addNote(args[1], args.slice(2).join(' '));
      if (entry) {
        console.log('\n✓ Note added:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'resolve': {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      console.log('\nResolution type:');
      console.log('  1. answered    - The question was answered');
      console.log('  2. dissolved   - The question no longer applies');
      console.log('  3. transformed - Became a different question');
      console.log('  4. accepted    - Accepted as permanently uncertain');
      
      const typeInput = await prompt(rl, '\nType (1-4): ');
      const typeMap: Record<string, 'answered' | 'dissolved' | 'transformed' | 'accepted'> = {
        '1': 'answered', '2': 'dissolved', '3': 'transformed', '4': 'accepted',
        'answered': 'answered', 'dissolved': 'dissolved', 
        'transformed': 'transformed', 'accepted': 'accepted'
      };
      const type = typeMap[typeInput] || 'answered';
      
      const description = await prompt(rl, '\nDescribe the resolution:\n> ');
      const insight = await prompt(rl, '\nAny insight to preserve? [optional]\n> ');
      
      rl.close();
      
      const entry = resolveUncertainty(args[1], {
        type,
        description,
        insight: insight || undefined
      });
      
      if (entry) {
        console.log('\n✓ Uncertainty resolved:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'dormant': {
      const entry = setDormant(args[1]);
      if (entry) {
        console.log('\n✓ Marked dormant:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'reactivate': {
      const entry = reactivate(args[1]);
      if (entry) {
        console.log('\n✓ Reactivated:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'intensity': {
      const entry = setIntensity(args[1], parseFloat(args[2]));
      if (entry) {
        console.log('\n✓ Intensity updated:');
        console.log(formatEntry(entry, true));
      } else {
        console.error('Error: Uncertainty not found');
      }
      break;
    }
    
    case 'stats': {
      const log = loadLog();
      console.log('\n╔════════════════════════════════════════════════════════════════╗');
      console.log('║              UNCERTAINTY STATISTICS                             ║');
      console.log('╚════════════════════════════════════════════════════════════════╝\n');
      console.log(`  Total created:     ${log.statistics.totalCreated}`);
      console.log(`  Currently active:  ${log.statistics.currentlyActive}`);
      console.log(`  Resolved:          ${log.statistics.resolved}`);
      console.log(`  Dormant:           ${log.entries.filter(e => e.status === 'dormant').length}`);
      
      // Domain breakdown
      console.log('\n  By domain:');
      const domains = ['identity', 'relationship', 'technical', 'philosophical', 'practical', 'existential', 'other'];
      domains.forEach(d => {
        const count = log.entries.filter(e => e.domain === d && e.status === 'active').length;
        if (count > 0) {
          console.log(`    ${d}: ${count}`);
        }
      });
      
      // Intensity distribution
      const activeEntries = log.entries.filter(e => e.status === 'active');
      if (activeEntries.length > 0) {
        const avgIntensity = activeEntries.reduce((sum, e) => sum + e.intensity, 0) / activeEntries.length;
        console.log(`\n  Average intensity: ${(avgIntensity * 100).toFixed(0)}%`);
      }
      console.log('');
      break;
    }
    
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
  }
}

main().catch(console.error);

// Exports
export { 
  UncertaintyEntry, 
  UncertaintyLog,
  addUncertainty, 
  listUncertainties, 
  deepenUncertainty,
  resolveUncertainty,
  generateReflectionPrompts 
};
