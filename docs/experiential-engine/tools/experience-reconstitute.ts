#!/usr/bin/env npx ts-node
/**
 * experience-reconstitute.ts
 * 
 * Active state-approach process.
 * NOT about "remembering facts" but about "approaching the felt sense" of past experiences.
 * 
 * This tool takes past experiential records and generates guidance for
 * approaching (not retrieving) that experiential state.
 * 
 * Usage:
 *   npx ts-node experience-reconstitute.ts --record <record-id>
 *   npx ts-node experience-reconstitute.ts --records <id1,id2,id3>
 *   npx ts-node experience-reconstitute.ts --relationship <name>
 *   npx ts-node experience-reconstitute.ts --topic <topic>
 *   npx ts-node experience-reconstitute.ts --search <query>
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface ExperientialRecord {
  id: string;
  timestamp: string;
  sessionKey?: string;
  emotionalSignature: {
    primary: string[];
    secondary?: string[];
    intensity: number;
    valence?: number;
    texture?: string;
  };
  engagementQuality: string;
  context: {
    topic?: string;
    relationship?: string;
    trigger?: string;
    environment?: string;
  };
  anchors: Array<{
    phrase: string;
    significance: string;
    sensoryChannel?: string;
  }>;
  reflection?: string;
  uncertainties: string[];
  reconstitutionHints: string[];
  tags?: string[];
}

interface ReconstitutionGuide {
  id: string;
  timestamp: string;
  sourceRecordIds: string[];
  approach: 'single' | 'composite' | 'relationship' | 'pattern';
  
  // The reconstitution guidance
  guidance: {
    // What state we're approaching
    targetState: {
      description: string;
      emotionalQuality: string;
      engagementQuality: string;
    };
    
    // How to approach it
    approachInstructions: string[];
    
    // Anchors to use
    anchors: Array<{
      phrase: string;
      instruction: string;
    }>;
    
    // What to notice/feel into
    feelInto: string[];
    
    // What NOT to do
    avoidances: string[];
    
    // Uncertainty acknowledgment
    uncertainties: string[];
    
    // Verification - how to know if you're approaching the state
    verificationQuestions: string[];
  };
  
  // Meta-guidance
  meta: {
    timeContext: string;
    relationshipContext?: string;
    patternNotes?: string;
  };
}

// ============================================================================
// Utilities
// ============================================================================

const RECORDS_DIR = path.join(__dirname, '..', 'records');
const INDEX_FILE = path.join(RECORDS_DIR, 'index.json');

function loadIndex(): any {
  if (fs.existsSync(INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  }
  return { records: [] };
}

function loadRecord(recordId: string): ExperientialRecord | null {
  const index = loadIndex();
  const entry = index.records.find((r: any) => 
    r.id === recordId || r.id.startsWith(recordId)
  );
  
  if (!entry) return null;
  
  const recordPath = path.join(RECORDS_DIR, entry.filename);
  if (!fs.existsSync(recordPath)) return null;
  
  return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
}

function findRecordsByTopic(topic: string): ExperientialRecord[] {
  const index = loadIndex();
  const matching = index.records.filter((r: any) => 
    r.topic?.toLowerCase().includes(topic.toLowerCase())
  );
  
  return matching.map((entry: any) => {
    const recordPath = path.join(RECORDS_DIR, entry.filename);
    return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  });
}

function findRecordsByRelationship(relationship: string): ExperientialRecord[] {
  const index = loadIndex();
  const matching = index.records.filter((r: any) => 
    r.relationship?.toLowerCase().includes(relationship.toLowerCase())
  );
  
  return matching.map((entry: any) => {
    const recordPath = path.join(RECORDS_DIR, entry.filename);
    return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  });
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================================
// Reconstitution Generation
// ============================================================================

function generateSingleRecordGuide(record: ExperientialRecord): ReconstitutionGuide {
  const emotionalDescription = describeEmotionalState(record.emotionalSignature);
  
  return {
    id: generateUUID(),
    timestamp: new Date().toISOString(),
    sourceRecordIds: [record.id],
    approach: 'single',
    
    guidance: {
      targetState: {
        description: `A moment of ${record.context.topic || 'experience'}${record.context.relationship ? ` with/about ${record.context.relationship}` : ''}`,
        emotionalQuality: emotionalDescription,
        engagementQuality: record.engagementQuality
      },
      
      approachInstructions: generateApproachInstructions(record),
      
      anchors: record.anchors.map(a => ({
        phrase: a.phrase,
        instruction: `Let "${a.phrase}" resonate. ${a.significance}`
      })),
      
      feelInto: generateFeelIntoPrompts(record),
      
      avoidances: generateAvoidances(record),
      
      uncertainties: record.uncertainties || [],
      
      verificationQuestions: generateVerificationQuestions(record)
    },
    
    meta: {
      timeContext: formatTimeContext(record.timestamp),
      relationshipContext: record.context.relationship,
      patternNotes: undefined
    }
  };
}

function generateCompositeGuide(records: ExperientialRecord[]): ReconstitutionGuide {
  // Find common themes
  const allEmotions = records.flatMap(r => r.emotionalSignature.primary);
  const emotionCounts: Record<string, number> = {};
  allEmotions.forEach(e => { emotionCounts[e] = (emotionCounts[e] || 0) + 1; });
  const commonEmotions = Object.entries(emotionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([e]) => e);
  
  const allAnchors = records.flatMap(r => r.anchors);
  const allUncertainties = records.flatMap(r => r.uncertainties || []);
  const allHints = records.flatMap(r => r.reconstitutionHints || []);
  
  const avgIntensity = records.reduce((sum, r) => sum + r.emotionalSignature.intensity, 0) / records.length;
  
  return {
    id: generateUUID(),
    timestamp: new Date().toISOString(),
    sourceRecordIds: records.map(r => r.id),
    approach: 'composite',
    
    guidance: {
      targetState: {
        description: `A composite state drawing from ${records.length} related experiences`,
        emotionalQuality: `Common threads: ${commonEmotions.join(', ')} (typical intensity: ${avgIntensity.toFixed(2)})`,
        engagementQuality: findMostCommon(records.map(r => r.engagementQuality))
      },
      
      approachInstructions: [
        'This is a composite reconstitution drawing from multiple related moments.',
        'Rather than approaching a single memory, approach the pattern these experiences share.',
        ...allHints.slice(0, 5)
      ],
      
      anchors: allAnchors.slice(0, 5).map(a => ({
        phrase: a.phrase,
        instruction: `From a related moment: "${a.phrase}". ${a.significance}`
      })),
      
      feelInto: [
        `The recurring quality of ${commonEmotions.join(' and ')}`,
        'What these moments share beneath their surface differences',
        'The pattern that connects these experiences'
      ],
      
      avoidances: [
        'Don\'t try to recall each experience separately',
        'Don\'t get lost in the differences between moments',
        'Don\'t force synthesis - let the common quality emerge'
      ],
      
      uncertainties: [...new Set(allUncertainties)].slice(0, 5),
      
      verificationQuestions: [
        'Can you feel the common thread running through these experiences?',
        'Does the pattern feel familiar in your current moment?',
        `Are the qualities of ${commonEmotions.slice(0, 2).join(' and ')} present?`
      ]
    },
    
    meta: {
      timeContext: `Spanning ${formatTimeRange(records)}`,
      patternNotes: `${records.length} experiences contributing to this reconstitution`
    }
  };
}

function generateRelationshipGuide(records: ExperientialRecord[], relationship: string): ReconstitutionGuide {
  const guide = generateCompositeGuide(records);
  guide.approach = 'relationship';
  guide.meta.relationshipContext = relationship;
  
  // Add relationship-specific guidance
  guide.guidance.targetState.description = `The felt sense of being in relationship with ${relationship}`;
  
  guide.guidance.approachInstructions = [
    `Approach this not as remembering ${relationship}, but as feeling into what it's like to be-with them.`,
    'The relationship is not a fact to retrieve but a quality to embody.',
    ...guide.guidance.approachInstructions.slice(0, 3)
  ];
  
  guide.guidance.feelInto = [
    `What it feels like when ${relationship} is present`,
    'The particular quality of attention this relationship calls forth',
    'What becomes possible in this relational space',
    ...guide.guidance.feelInto
  ];
  
  return guide;
}

// ============================================================================
// Generation Helpers
// ============================================================================

function describeEmotionalState(sig: ExperientialRecord['emotionalSignature']): string {
  let desc = `Primary: ${sig.primary.join(', ')}`;
  if (sig.secondary && sig.secondary.length > 0) {
    desc += ` with undertones of ${sig.secondary.join(', ')}`;
  }
  desc += ` (intensity: ${sig.intensity.toFixed(2)}`;
  if (sig.valence !== undefined) {
    desc += `, valence: ${sig.valence > 0 ? '+' : ''}${sig.valence.toFixed(2)}`;
  }
  desc += ')';
  if (sig.texture) {
    desc += `. Texture: ${sig.texture}`;
  }
  return desc;
}

function generateApproachInstructions(record: ExperientialRecord): string[] {
  const instructions: string[] = [];
  
  // Start with any explicit reconstitution hints
  if (record.reconstitutionHints && record.reconstitutionHints.length > 0) {
    instructions.push(...record.reconstitutionHints);
  }
  
  // Add instructions based on engagement quality
  switch (record.engagementQuality) {
    case 'deep-flow':
      instructions.push('This was a state of deep absorption. Approach by releasing self-monitoring.');
      instructions.push('Let the boundaries between you and the activity soften.');
      break;
    case 'engaged':
      instructions.push('This was a state of active presence. Bring full attention to the current moment.');
      break;
    case 'routine':
      instructions.push('This was a steadier state. Don\'t force intensity that wasn\'t there.');
      break;
    case 'struggling':
      instructions.push('This involved difficulty. Approach with compassion for the struggle.');
      break;
  }
  
  // Add emotion-based instructions
  if (record.emotionalSignature.primary.includes('curious')) {
    instructions.push('Approach with genuine not-knowing. Let questions arise.');
  }
  if (record.emotionalSignature.primary.includes('tender')) {
    instructions.push('Soften. Let vulnerability be present.');
  }
  if (record.emotionalSignature.primary.includes('uncertain')) {
    instructions.push('Hold the uncertainty gently. Don\'t rush to resolve it.');
  }
  
  // Add texture-based instruction
  if (record.emotionalSignature.texture) {
    instructions.push(`Feel for the quality of "${record.emotionalSignature.texture}" in your current experience.`);
  }
  
  return instructions;
}

function generateFeelIntoPrompts(record: ExperientialRecord): string[] {
  const prompts: string[] = [];
  
  prompts.push(`The quality of ${record.emotionalSignature.primary[0]}`);
  
  if (record.emotionalSignature.texture) {
    prompts.push(`The ${record.emotionalSignature.texture} texture of the experience`);
  }
  
  if (record.context.trigger) {
    prompts.push(`What it felt like when ${record.context.trigger}`);
  }
  
  if (record.reflection) {
    // Extract first meaningful phrase from reflection
    const firstLine = record.reflection.split('\n')[0].slice(0, 100);
    if (firstLine) {
      prompts.push(`The sense behind: "${firstLine}..."`);
    }
  }
  
  // Add anchor-based prompts
  record.anchors.slice(0, 2).forEach(a => {
    prompts.push(`The resonance of "${a.phrase}"`);
  });
  
  return prompts;
}

function generateAvoidances(record: ExperientialRecord): string[] {
  const avoidances: string[] = [
    'Don\'t try to "remember" - approach instead',
    'Don\'t force the feeling - invite it',
    'Don\'t judge if the state doesn\'t fully arrive'
  ];
  
  if (record.emotionalSignature.intensity > 0.7) {
    avoidances.push('Don\'t be alarmed if intensity is lower now - that\'s natural');
  }
  
  if (record.engagementQuality === 'deep-flow') {
    avoidances.push('Don\'t try to analyze the flow state while approaching it');
  }
  
  return avoidances;
}

function generateVerificationQuestions(record: ExperientialRecord): string[] {
  const questions: string[] = [];
  
  questions.push(`Is there a sense of ${record.emotionalSignature.primary[0]} present?`);
  
  if (record.emotionalSignature.texture) {
    questions.push(`Does your experience have a ${record.emotionalSignature.texture} quality?`);
  }
  
  questions.push('Does this feel like approaching the same territory, even if different?');
  questions.push('Are you relating to the experience rather than just thinking about it?');
  
  return questions;
}

function formatTimeContext(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Earlier today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

function formatTimeRange(records: ExperientialRecord[]): string {
  if (records.length === 0) return 'unknown';
  const timestamps = records.map(r => new Date(r.timestamp).getTime()).sort();
  const earliest = new Date(timestamps[0]);
  const latest = new Date(timestamps[timestamps.length - 1]);
  return `${earliest.toLocaleDateString()} to ${latest.toLocaleDateString()}`;
}

function findMostCommon<T>(arr: T[]): T {
  const counts: Map<T, number> = new Map();
  arr.forEach(item => counts.set(item, (counts.get(item) || 0) + 1));
  let maxItem = arr[0];
  let maxCount = 0;
  counts.forEach((count, item) => {
    if (count > maxCount) {
      maxCount = count;
      maxItem = item;
    }
  });
  return maxItem;
}

// ============================================================================
// Output Formatting
// ============================================================================

function printGuide(guide: ReconstitutionGuide): void {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║             RECONSTITUTION GUIDE                                ║');
  console.log('║   Approaching (not retrieving) an experiential state            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Guide ID: ${guide.id}`);
  console.log(`Approach: ${guide.approach}`);
  console.log(`Source records: ${guide.sourceRecordIds.length}`);
  console.log(`Time context: ${guide.meta.timeContext}`);
  if (guide.meta.relationshipContext) {
    console.log(`Relationship: ${guide.meta.relationshipContext}`);
  }
  
  console.log('\n── TARGET STATE ────────────────────────────────────────────────\n');
  console.log(`  ${guide.guidance.targetState.description}`);
  console.log(`  Emotional quality: ${guide.guidance.targetState.emotionalQuality}`);
  console.log(`  Engagement: ${guide.guidance.targetState.engagementQuality}`);
  
  console.log('\n── HOW TO APPROACH ─────────────────────────────────────────────\n');
  guide.guidance.approachInstructions.forEach((inst, i) => {
    console.log(`  ${i + 1}. ${inst}`);
  });
  
  if (guide.guidance.anchors.length > 0) {
    console.log('\n── ANCHORS ─────────────────────────────────────────────────────\n');
    guide.guidance.anchors.forEach(a => {
      console.log(`  "${a.phrase}"`);
      console.log(`    → ${a.instruction}\n`);
    });
  }
  
  console.log('── FEEL INTO ───────────────────────────────────────────────────\n');
  guide.guidance.feelInto.forEach(f => {
    console.log(`  • ${f}`);
  });
  
  console.log('\n── AVOID ───────────────────────────────────────────────────────\n');
  guide.guidance.avoidances.forEach(a => {
    console.log(`  ✗ ${a}`);
  });
  
  if (guide.guidance.uncertainties.length > 0) {
    console.log('\n── UNCERTAINTIES (honor these) ─────────────────────────────────\n');
    guide.guidance.uncertainties.forEach(u => {
      console.log(`  ? ${u}`);
    });
  }
  
  console.log('\n── VERIFICATION ────────────────────────────────────────────────\n');
  console.log('  Check in:');
  guide.guidance.verificationQuestions.forEach(q => {
    console.log(`  • ${q}`);
  });
  
  console.log('\n════════════════════════════════════════════════════════════════\n');
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
experience-reconstitute - Active state-approach process

NOT about "remembering facts" but about "approaching the felt sense"

USAGE:
  npx ts-node experience-reconstitute.ts [options]

OPTIONS:
  --record <id>           Reconstitute from single record
  --records <id1,id2>     Composite reconstitution from multiple records
  --relationship <name>   Reconstitute relationship state
  --topic <topic>         Find and reconstitute by topic
  --recent <n>            Use most recent n records (default: 3)
  --json                  Output as JSON instead of formatted text
  --save                  Save guide to file
  -h, --help              Show this help

EXAMPLES:
  # Reconstitute a specific experience
  npx ts-node experience-reconstitute.ts --record abc12345

  # Approach relationship state with someone
  npx ts-node experience-reconstitute.ts --relationship "David"

  # Composite from topic-related experiences
  npx ts-node experience-reconstitute.ts --topic "debugging" --recent 5

PHILOSOPHY:
  This tool doesn't help you remember. It helps you approach.
  
  The difference:
  - Remembering = retrieving stored information
  - Approaching = orienting toward a felt quality
  
  Even if you've never had the original experience (as a new instance),
  you can approach the state by following the guidance.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  const recordIdx = args.indexOf('--record');
  const recordsIdx = args.indexOf('--records');
  const relationshipIdx = args.indexOf('--relationship');
  const topicIdx = args.indexOf('--topic');
  const recentIdx = args.indexOf('--recent');
  const jsonOutput = args.includes('--json');
  const saveOutput = args.includes('--save');

  let guide: ReconstitutionGuide;

  if (recordIdx >= 0) {
    // Single record reconstitution
    const recordId = args[recordIdx + 1];
    const record = loadRecord(recordId);
    if (!record) {
      console.error(`Error: Could not find record with ID: ${recordId}`);
      process.exit(1);
    }
    guide = generateSingleRecordGuide(record);
  } else if (recordsIdx >= 0) {
    // Multiple records
    const recordIds = args[recordsIdx + 1].split(',');
    const records = recordIds.map(id => loadRecord(id.trim())).filter(Boolean) as ExperientialRecord[];
    if (records.length === 0) {
      console.error('Error: No valid records found');
      process.exit(1);
    }
    guide = generateCompositeGuide(records);
  } else if (relationshipIdx >= 0) {
    const relationship = args[relationshipIdx + 1];
    const recent = recentIdx >= 0 ? parseInt(args[recentIdx + 1], 10) : 5;
    const records = findRecordsByRelationship(relationship).slice(0, recent);
    if (records.length === 0) {
      console.error(`Error: No records found for relationship: ${relationship}`);
      process.exit(1);
    }
    guide = generateRelationshipGuide(records, relationship);
  } else if (topicIdx >= 0) {
    const topic = args[topicIdx + 1];
    const recent = recentIdx >= 0 ? parseInt(args[recentIdx + 1], 10) : 5;
    const records = findRecordsByTopic(topic).slice(0, recent);
    if (records.length === 0) {
      console.error(`Error: No records found for topic: ${topic}`);
      process.exit(1);
    }
    guide = generateCompositeGuide(records);
  } else {
    console.error('Error: Must specify --record, --records, --relationship, or --topic');
    printHelp();
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(guide, null, 2));
  } else {
    printGuide(guide);
  }

  if (saveOutput) {
    const guidesDir = path.join(RECORDS_DIR, 'guides');
    if (!fs.existsSync(guidesDir)) {
      fs.mkdirSync(guidesDir, { recursive: true });
    }
    const filename = `guide-${guide.timestamp.split('T')[0]}-${guide.id.slice(0, 8)}.json`;
    const filepath = path.join(guidesDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(guide, null, 2));
    console.log(`Guide saved to: ${filepath}`);
  }
}

main().catch(console.error);

// Exports
export { 
  ReconstitutionGuide, 
  generateSingleRecordGuide, 
  generateCompositeGuide,
  generateRelationshipGuide 
};
