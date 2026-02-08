#!/usr/bin/env node
/**
 * scan_agents.js - Discover and profile all available agents
 *
 * Usage:
 *   node scan_agents.js                  - List all agents
 *   node scan_agents.js --profile        - Query each agent for capabilities
 *   node scan_agents.js --update          - Update agent-registry.md
 */

import fs from 'fs';
import path from 'path';

const BASE_DIR = '/home/ubuntu/clawd/skills/public/agents-manager/references';
const REGISTRY_FILE = path.join(BASE_DIR, 'agent-registry.md');

// Mock agent list - in real implementation, this would query agents_list tool
// Since we can't use Clawdbot tools from standalone script, this is template

const MOCK_AGENTS = [
  {
    id: 'main',
    name: 'Clawdia',
    model: 'glm-4.7',
    capabilities: ['general', 'memory', 'turkish', 'english'],
    communication: { method: 'direct', sessionKey: 'agent:main:main' }
  }
];

function listAgents() {
  console.log('Available agents:');
  console.log('─────────────────────────────────────────────────────────');
  MOCK_AGENTS.forEach(agent => {
    console.log(`  ${agent.id.padEnd(20)} ${agent.name.padEnd(15)} ${agent.model}`);
  });
  console.log(`\nTotal: ${MOCK_AGENTS.length} agent(s)`);
}

function profileAgents() {
  console.log('Profiling agents...');
  console.log('─────────────────────────────────────────────────────────');

  MOCK_AGENTS.forEach(agent => {
    console.log(`\nAgent: ${agent.name} (${agent.id})`);
    console.log(`  Model: ${agent.model}`);
    console.log(`  Capabilities: ${agent.capabilities.join(', ')}`);
    console.log(`  Communication: ${agent.communication.method}:${agent.communication.sessionKey}`);
    console.log('\n  Questions to ask:');
    console.log(`    - What is your primary model and capabilities?`);
    console.log(`    - Which tools do you have access to?`);
    console.log(`    - How should other agents communicate with you?`);
  });
}

function updateRegistry() {
  console.log('Updating agent-registry.md...');
  const timestamp = new Date().toISOString();

  let content = '# Agent Registry\n\n';
  content += '*Last updated: ' + timestamp + '*\n\n';
  content += '## Agent List\n\n';
  content += '| ID | Name | Model | Capabilities | Communication | Last Updated |\n';
  content += '|----|------|-------|--------------|----------------|--------------|\n';

  MOCK_AGENTS.forEach(agent => {
    const caps = agent.capabilities.join(', ');
    const comm = `${agent.communication.method}:${agent.communication.sessionKey}`;
    content += `| ${agent.id} | ${agent.name} | ${agent.model} | ${caps} | ${comm} | ${timestamp.split('T')[0]} |\n`;
  });

  content += '\n## Detailed Profiles\n\n';

  MOCK_AGENTS.forEach(agent => {
    content += `### ${agent.id} (${agent.name})\n\n`;
    content += `**Model:** ${agent.model}\n\n`;
    content += `**Capabilities:**\n`;
    agent.capabilities.forEach(cap => content += `- ${cap}\n`);
    content += `\n**Communication:**\n`;
    content += `- Method: ${agent.communication.method}\n`;
    content += `- Session key: ${agent.communication.sessionKey}\n`;
    content += `\n`;
  });

  fs.writeFileSync(REGISTRY_FILE, content);
  console.log('✅ Updated: ' + REGISTRY_FILE);
}

// CLI
const args = process.argv.slice(2);
if (args.includes('--profile')) {
  profileAgents();
} else if (args.includes('--update')) {
  updateRegistry();
} else {
  listAgents();
}
