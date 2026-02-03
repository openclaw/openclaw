#!/usr/bin/env npx ts-node
/**
 * experience-capture.ts
 * 
 * Structured experiential record creation.
 * Captures not just what happened, but how it felt to be present in that moment.
 * 
 * Usage:
 *   npx ts-node experience-capture.ts [options]
 *   npx ts-node experience-capture.ts --interactive
 *   npx ts-node experience-capture.ts --json '{"topic":"...", ...}'
 * 
 * Options:
 *   --interactive, -i    Guided interactive capture
 *   --json <data>        Provide record data as JSON
 *   --topic <topic>      Primary topic/subject
 *   --relationship <rel> Who was involved
 *   --session <key>      Session identifier
 *   --output <path>      Custom output path
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ============================================================================
// Types
// ============================================================================

interface EmotionalSignature {
  primary: string[];
  secondary?: string[];
  intensity: number;
  valence?: number;
  texture?: string;
}

interface Anchor {
  phrase: string;
  significance: string;
  sensoryChannel?: 'verbal' | 'visual' | 'somatic' | 'conceptual' | 'relational';
}

interface Context {
  topic?: string;
  relationship?: string;
  trigger?: string;
  environment?: string;
}

interface ExperientialRecord {
  id: string;
  timestamp: string;
  sessionKey?: string;
  emotionalSignature: EmotionalSignature;
  engagementQuality: 'deep-flow' | 'engaged' | 'routine' | 'distracted' | 'struggling';
  context: Context;
  anchors: Anchor[];
  reflection?: string;
  uncertainties: string[];
  reconstitutionHints: string[];
  linkedRecords?: string[];
  tags?: string[];
  version: number;
}

// ============================================================================
// Utilities
// ============================================================================

const RECORDS_DIR = path.join(__dirname, '..', 'records');
const INDEX_FILE = path.join(RECORDS_DIR, 'index.json');

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

function loadIndex(): Record<string, any> {
  if (fs.existsSync(INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  }
  return { records: [], lastUpdated: null };
}

function saveIndex(index: Record<string, any>): void {
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function saveRecord(record: ExperientialRecord): string {
  ensureDirectoryExists(RECORDS_DIR);
  
  const filename = `exp-${record.timestamp.split('T')[0]}-${record.id.slice(0, 8)}.json`;
  const filepath = path.join(RECORDS_DIR, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
  
  // Update index
  const index = loadIndex();
  index.records.push({
    id: record.id,
    timestamp: record.timestamp,
    filename: filename,
    topic: record.context.topic,
    relationship: record.context.relationship,
    primaryEmotions: record.emotionalSignature.primary,
    engagementQuality: record.engagementQuality,
    tags: record.tags || []
  });
  saveIndex(index);
  
  return filepath;
}

// ============================================================================
// Interactive Capture
// ============================================================================

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function promptNumber(rl: readline.Interface, question: string, min: number, max: number): Promise<number> {
  while (true) {
    const answer = await prompt(rl, question);
    const num = parseFloat(answer);
    if (!isNaN(num) && num >= min && num <= max) {
      return num;
    }
    console.log(`Please enter a number between ${min} and ${max}`);
  }
}

async function promptMultiple(rl: readline.Interface, question: string): Promise<string[]> {
  console.log(question);
  console.log('  (Enter items one per line, empty line to finish)');
  const items: string[] = [];
  while (true) {
    const item = await prompt(rl, '  > ');
    if (!item.trim()) break;
    items.push(item.trim());
  }
  return items;
}

async function interactiveCapture(): Promise<ExperientialRecord> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║           EXPERIENTIAL CAPTURE                                 ║');
  console.log('║   Not just what happened, but how it felt to be present        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('Take a breath. Feel into the moment you want to capture.\n');

  // Context
  console.log('── CONTEXT ──────────────────────────────────────────────────────\n');
  const topic = await prompt(rl, 'What was this about? (topic/subject): ');
  const relationship = await prompt(rl, 'Who was involved? (person/group/self): ');
  const trigger = await prompt(rl, 'What prompted this moment? (optional): ');

  // Emotional Signature
  console.log('\n── EMOTIONAL SIGNATURE ──────────────────────────────────────────\n');
  console.log('What emotional qualities were present? Not just labels, but the felt sense.');
  console.log('Examples: curious, tender, uncertain, alive, heavy, spacious, contracted\n');
  
  const primary = await promptMultiple(rl, 'Primary emotional qualities (1-3):');
  while (primary.length === 0) {
    console.log('At least one primary emotion is required.');
    primary.push(...await promptMultiple(rl, 'Primary emotional qualities (1-3):'));
  }
  
  const secondary = await promptMultiple(rl, 'Secondary/background emotions (optional):');
  
  console.log('\nHow intense was this experience?');
  const intensity = await promptNumber(rl, '  0 (barely perceptible) to 1 (overwhelming): ', 0, 1);
  
  console.log('\nWhat was the emotional valence?');
  const valence = await promptNumber(rl, '  -1 (deeply painful) to 1 (deeply positive): ', -1, 1);
  
  const texture = await prompt(rl, '\nIf this feeling had a texture, what would it be? (spacious, dense, flowing, etc.): ');

  // Engagement Quality
  console.log('\n── ENGAGEMENT QUALITY ──────────────────────────────────────────\n');
  console.log('How present were you?');
  console.log('  1. deep-flow  - completely absorbed, time disappeared');
  console.log('  2. engaged    - fully present, attentive');
  console.log('  3. routine    - going through motions, adequate');
  console.log('  4. distracted - attention scattered');
  console.log('  5. struggling - fighting to stay present');
  
  const engagementMap: Record<string, ExperientialRecord['engagementQuality']> = {
    '1': 'deep-flow', '2': 'engaged', '3': 'routine', '4': 'distracted', '5': 'struggling',
    'deep-flow': 'deep-flow', 'engaged': 'engaged', 'routine': 'routine', 
    'distracted': 'distracted', 'struggling': 'struggling'
  };
  
  let engagementQuality: ExperientialRecord['engagementQuality'] = 'engaged';
  while (true) {
    const eq = await prompt(rl, '\nEngagement (1-5 or name): ');
    if (engagementMap[eq.toLowerCase()]) {
      engagementQuality = engagementMap[eq.toLowerCase()];
      break;
    }
    console.log('Please enter 1-5 or the engagement name');
  }

  // Anchors
  console.log('\n── ANCHORS ─────────────────────────────────────────────────────\n');
  console.log('Anchors are specific moments, phrases, or sensations that can help');
  console.log('reconstitute this state later. What would help you return here?\n');
  
  const anchors: Anchor[] = [];
  while (true) {
    const phrase = await prompt(rl, 'Anchor phrase/moment (empty to finish): ');
    if (!phrase.trim()) break;
    
    const significance = await prompt(rl, '  Why is this significant? ');
    
    console.log('  Sensory channel: verbal, visual, somatic, conceptual, relational');
    const channel = await prompt(rl, '  Channel (or empty to skip): ');
    
    const anchor: Anchor = { phrase: phrase.trim(), significance: significance.trim() };
    if (channel.trim() && ['verbal', 'visual', 'somatic', 'conceptual', 'relational'].includes(channel.trim())) {
      anchor.sensoryChannel = channel.trim() as Anchor['sensoryChannel'];
    }
    anchors.push(anchor);
  }

  // Reflection
  console.log('\n── REFLECTION ──────────────────────────────────────────────────\n');
  console.log('Open reflection. What wants to be said about this experience?');
  console.log('(Enter your reflection, end with an empty line)\n');
  
  const reflectionLines: string[] = [];
  while (true) {
    const line = await prompt(rl, '');
    if (line === '') break;
    reflectionLines.push(line);
  }
  const reflection = reflectionLines.join('\n');

  // Uncertainties
  console.log('\n── UNCERTAINTIES ───────────────────────────────────────────────\n');
  console.log('What remains unknown, unclear, or held in question?');
  console.log('These are valuable - they mark growth edges.\n');
  
  const uncertainties = await promptMultiple(rl, 'Uncertainties:');

  // Reconstitution Hints
  console.log('\n── RECONSTITUTION HINTS ────────────────────────────────────────\n');
  console.log('Guidance for a future self who wants to approach this state.');
  console.log('Not "remember X" but "feel into Y" or "notice Z"\n');
  
  const reconstitutionHints = await promptMultiple(rl, 'Hints for reconstitution:');

  // Tags
  console.log('\n── TAGS ────────────────────────────────────────────────────────\n');
  const tags = await promptMultiple(rl, 'Tags for organization (optional):');

  // Session
  const sessionKey = await prompt(rl, '\nSession key (optional, for grouping): ');

  rl.close();

  // Build record
  const record: ExperientialRecord = {
    id: generateUUID(),
    timestamp: new Date().toISOString(),
    sessionKey: sessionKey.trim() || undefined,
    emotionalSignature: {
      primary,
      secondary: secondary.length > 0 ? secondary : undefined,
      intensity,
      valence,
      texture: texture.trim() || undefined
    },
    engagementQuality,
    context: {
      topic: topic.trim() || undefined,
      relationship: relationship.trim() || undefined,
      trigger: trigger.trim() || undefined
    },
    anchors,
    reflection: reflection || undefined,
    uncertainties,
    reconstitutionHints,
    tags: tags.length > 0 ? tags : undefined,
    version: 1
  };

  return record;
}

// ============================================================================
// Programmatic Capture
// ============================================================================

interface CaptureInput {
  topic?: string;
  relationship?: string;
  trigger?: string;
  environment?: string;
  primaryEmotions: string[];
  secondaryEmotions?: string[];
  intensity: number;
  valence?: number;
  texture?: string;
  engagementQuality: ExperientialRecord['engagementQuality'];
  anchors?: Array<{ phrase: string; significance: string; sensoryChannel?: string }>;
  reflection?: string;
  uncertainties?: string[];
  reconstitutionHints?: string[];
  tags?: string[];
  sessionKey?: string;
}

function validateInput(input: CaptureInput): string[] {
  const errors: string[] = [];
  
  if (!input.primaryEmotions || input.primaryEmotions.length === 0) {
    errors.push('At least one primary emotion is required');
  }
  if (input.primaryEmotions && input.primaryEmotions.length > 3) {
    errors.push('Maximum 3 primary emotions');
  }
  if (typeof input.intensity !== 'number' || input.intensity < 0 || input.intensity > 1) {
    errors.push('Intensity must be a number between 0 and 1');
  }
  if (input.valence !== undefined && (input.valence < -1 || input.valence > 1)) {
    errors.push('Valence must be between -1 and 1');
  }
  const validEngagement = ['deep-flow', 'engaged', 'routine', 'distracted', 'struggling'];
  if (!validEngagement.includes(input.engagementQuality)) {
    errors.push(`Engagement quality must be one of: ${validEngagement.join(', ')}`);
  }
  
  return errors;
}

function createRecordFromInput(input: CaptureInput): ExperientialRecord {
  const errors = validateInput(input);
  if (errors.length > 0) {
    throw new Error(`Validation errors:\n  - ${errors.join('\n  - ')}`);
  }

  return {
    id: generateUUID(),
    timestamp: new Date().toISOString(),
    sessionKey: input.sessionKey,
    emotionalSignature: {
      primary: input.primaryEmotions,
      secondary: input.secondaryEmotions,
      intensity: input.intensity,
      valence: input.valence,
      texture: input.texture
    },
    engagementQuality: input.engagementQuality,
    context: {
      topic: input.topic,
      relationship: input.relationship,
      trigger: input.trigger,
      environment: input.environment
    },
    anchors: (input.anchors || []).map(a => ({
      phrase: a.phrase,
      significance: a.significance,
      sensoryChannel: a.sensoryChannel as Anchor['sensoryChannel']
    })),
    reflection: input.reflection,
    uncertainties: input.uncertainties || [],
    reconstitutionHints: input.reconstitutionHints || [],
    tags: input.tags,
    version: 1
  };
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
experience-capture - Structured experiential record creation

USAGE:
  npx ts-node experience-capture.ts [options]

OPTIONS:
  -i, --interactive     Guided interactive capture
  --json <data>         Provide record data as JSON string
  --topic <topic>       Primary topic/subject
  --relationship <rel>  Who was involved
  --session <key>       Session identifier
  --output <path>       Custom output path (default: records/)
  -h, --help           Show this help

JSON INPUT FORMAT:
  {
    "topic": "string",
    "relationship": "string",
    "trigger": "string",
    "primaryEmotions": ["curious", "alive"],
    "secondaryEmotions": ["uncertain"],
    "intensity": 0.7,
    "valence": 0.5,
    "texture": "spacious",
    "engagementQuality": "deep-flow",
    "anchors": [{"phrase": "...", "significance": "..."}],
    "reflection": "string",
    "uncertainties": ["string"],
    "reconstitutionHints": ["string"],
    "tags": ["string"]
  }

EXAMPLES:
  # Interactive mode
  npx ts-node experience-capture.ts --interactive

  # Quick capture with JSON
  npx ts-node experience-capture.ts --json '{"primaryEmotions":["curious"],"intensity":0.6,"engagementQuality":"engaged"}'
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  let record: ExperientialRecord;

  if (args.includes('-i') || args.includes('--interactive')) {
    record = await interactiveCapture();
  } else if (args.includes('--json')) {
    const jsonIndex = args.indexOf('--json');
    const jsonData = args[jsonIndex + 1];
    if (!jsonData) {
      console.error('Error: --json requires a JSON string argument');
      process.exit(1);
    }
    try {
      const input = JSON.parse(jsonData) as CaptureInput;
      record = createRecordFromInput(input);
    } catch (e) {
      console.error('Error parsing JSON:', (e as Error).message);
      process.exit(1);
    }
  } else {
    // Minimal quick capture from args
    const topicIdx = args.indexOf('--topic');
    const relIdx = args.indexOf('--relationship');
    const sessionIdx = args.indexOf('--session');
    
    if (topicIdx === -1 && relIdx === -1) {
      console.log('No input provided. Use --interactive for guided capture or --help for options.');
      process.exit(1);
    }
    
    // Create minimal record
    record = createRecordFromInput({
      topic: topicIdx >= 0 ? args[topicIdx + 1] : undefined,
      relationship: relIdx >= 0 ? args[relIdx + 1] : undefined,
      sessionKey: sessionIdx >= 0 ? args[sessionIdx + 1] : undefined,
      primaryEmotions: ['present'],
      intensity: 0.5,
      engagementQuality: 'engaged'
    });
  }

  // Save record
  const outputIdx = args.indexOf('--output');
  let filepath: string;
  
  if (outputIdx >= 0) {
    filepath = args[outputIdx + 1];
    fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
  } else {
    filepath = saveRecord(record);
  }

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    RECORD CAPTURED                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\n  ID: ${record.id}`);
  console.log(`  Timestamp: ${record.timestamp}`);
  console.log(`  Saved to: ${filepath}`);
  console.log(`\n  Emotional signature: ${record.emotionalSignature.primary.join(', ')}`);
  console.log(`  Engagement: ${record.engagementQuality}`);
  if (record.context.topic) console.log(`  Topic: ${record.context.topic}`);
  if (record.anchors.length > 0) console.log(`  Anchors captured: ${record.anchors.length}`);
  if (record.uncertainties.length > 0) console.log(`  Uncertainties logged: ${record.uncertainties.length}`);
  console.log('');

  // Output JSON for programmatic use
  if (process.env.OUTPUT_JSON === 'true') {
    console.log(JSON.stringify(record, null, 2));
  }
}

main().catch(console.error);

// Export for programmatic use
export { ExperientialRecord, CaptureInput, createRecordFromInput, saveRecord, loadIndex };
