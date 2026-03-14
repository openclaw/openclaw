#!/usr/bin/env node

/**
 * Office CLI - Multi-Agent Team Management
 * 
 * Usage:
 *   node office-cli.js <command> [options]
 * 
 * Commands:
 *   dashboard    Show agent and team dashboard
 *   team         Manage teams (create, list, info, kill)
 *   send         Send message to agent or team
 *   spawn        Spawn agent session with task
 *   sessions     Manage office sessions
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OFFICE_DIR = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'office');
const TEAMS_FILE = path.join(OFFICE_DIR, 'teams.json');
const SESSIONS_FILE = path.join(OFFICE_DIR, 'sessions.json');

// Ensure office directory exists
function ensureOfficeDir() {
  if (!fs.existsSync(OFFICE_DIR)) {
    fs.mkdirSync(OFFICE_DIR, { recursive: true });
  }
}

// Load teams from storage
function loadTeams() {
  if (!fs.existsSync(TEAMS_FILE)) {
    return { teams: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  } catch (e) {
    return { teams: {} };
  }
}

// Save teams to storage
function saveTeams(data) {
  ensureOfficeDir();
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(data, null, 2));
}

// Run openclaw CLI command
function runOpenClaw(args, json = false) {
  try {
    const cmd = `openclaw ${args.join(' ')} ${json ? '--json' : ''}`;
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}

// Get list of available agents
function getAgentsList() {
  try {
    const output = runOpenClaw(['agents', 'list', '--json'], true);
    return JSON.parse(output);
  } catch (e) {
    return [];
  }
}

// Get list of active sessions
function getSessionsList(activeMinutes = 60) {
  try {
    const output = runOpenClaw(['sessions', 'list', '--active', activeMinutes.toString(), '--json'], true);
    return JSON.parse(output);
  } catch (e) {
    return { sessions: [] };
  }
}

// Dashboard command
function cmdDashboard(options) {
  const agents = getAgentsList();
  const sessions = getSessionsList(options.active ? 30 : 60);
  const teamsData = loadTeams();
  
  console.log('\n🏢 Office Dashboard - ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  console.log('═'.repeat(60));
  
  // Active Agents Section
  console.log('\n📋 Available Agents:');
  if (agents.length === 0) {
    console.log('  No agents configured');
  } else {
    console.log('┌─────────┬──────────────┬─────────────┬──────────────┐');
    console.log('│ Agent   │ Status       │ Sessions    │ Model        │');
    console.log('├─────────┼──────────────┼─────────────┼──────────────┤');
    
    agents.forEach(agent => {
      const agentId = agent.id || String(agent);
      const agentSessions = sessions.sessions?.filter(s => s.key?.includes(agentId)) || [];
      const status = agentSessions.length > 0 ? '🟢 Active' : '🟡 Idle';
      console.log(`│ ${agentId.padEnd(9)} │ ${status.padEnd(12)} │ ${String(agentSessions.length).padEnd(11)} │ ${'configured'.padEnd(12)} │`);
    });
    
    console.log('└─────────┴──────────────┴─────────────┴──────────────┘');
  }
  
  // Active Teams Section
  console.log('\n👥 Active Teams:');
  const teams = Object.values(teamsData.teams || {});
  if (teams.length === 0) {
    console.log('  No teams created yet');
  } else {
    console.log('┌───────────┬─────────────┬────────────┬──────────────┐');
    console.log('│ Team      │ Members     │ Orchestrator│ Status      │');
    console.log('├───────────┼─────────────┼────────────┼──────────────┤');
    
    teams.forEach(team => {
      const memberCount = team.members?.length || 0;
      const orchestrator = team.orchestrator || 'N/A';
      const status = team.status === 'active' ? '🟢 Working' : '🟡 Idle';
      console.log(`│ ${team.name.padEnd(9)} │ ${String(memberCount).padEnd(11)} │ ${orchestrator.padEnd(10)} │ ${status.padEnd(12)} │`);
    });
    
    console.log('└─────────┴─────────────┴────────────┴──────────────┘');
  }
  
  // Quick Stats
  console.log('\n📊 Quick Stats:');
  console.log(`  Total Agents: ${agents.length}`);
  console.log(`  Active Teams: ${teams.length}`);
  console.log(`  Active Sessions: ${sessions.sessions?.length || 0}`);
  console.log('');
}

// Team create command
function cmdTeamCreate(name, options) {
  const agents = options.agents?.split(',') || [];
  const orchestrator = options.orchestrator || 'main';
  
  if (agents.length === 0) {
    console.error('❌ Error: At least one agent required (--agents agent1,agent2,...)');
    process.exit(1);
  }
  
  const teamsData = loadTeams();
  
  if (teamsData.teams[name]) {
    console.error(`❌ Error: Team "${name}" already exists`);
    process.exit(1);
  }
  
  // Create team record
  const team = {
    name,
    sessionKey: `agent:${orchestrator}:office:team:${name}`,
    sessionId: `office-team-${Date.now()}`,
    createdAt: new Date().toISOString(),
    members: agents.map(agentId => ({ agentId, role: 'worker' })),
    orchestrator,
    status: 'active'
  };
  
  teamsData.teams[name] = team;
  saveTeams(teamsData);
  
  console.log(`✅ Team "${name}" created successfully!`);
  console.log(`   Session Key: ${team.sessionKey}`);
  console.log(`   Members: ${agents.join(', ')}`);
  console.log(`   Orchestrator: ${orchestrator}`);
  console.log('\n💡 Use "/office team info ${name}" to view details');
}

// Team list command
function cmdTeamList() {
  const teamsData = loadTeams();
  const teams = Object.values(teamsData.teams || {});
  
  if (teams.length === 0) {
    console.log('No teams created yet');
    return;
  }
  
  console.log('\n👥 Teams:\n');
  teams.forEach(team => {
    console.log(`• ${team.name}`);
    console.log(`  Created: ${team.createdAt}`);
    console.log(`  Members: ${team.members?.map(m => m.agentId).join(', ') || 'None'}`);
    console.log(`  Status: ${team.status}`);
    console.log('');
  });
}

// Team info command
function cmdTeamInfo(name) {
  const teamsData = loadTeams();
  const team = teamsData.teams[name];
  
  if (!team) {
    console.error(`❌ Error: Team "${name}" not found`);
    process.exit(1);
  }
  
  console.log('\n📋 Team Info:\n');
  console.log(`Name:         ${team.name}`);
  console.log(`Session Key:  ${team.sessionKey}`);
  console.log(`Session ID:   ${team.sessionId}`);
  console.log(`Created:      ${team.createdAt}`);
  console.log(`Orchestrator: ${team.orchestrator}`);
  console.log(`Status:       ${team.status}`);
  console.log('\nMembers:');
  
  team.members?.forEach((member, idx) => {
    console.log(`  ${idx + 1}. ${member.agentId} (${member.role || 'worker'})`);
  });
  
  console.log('');
}

// Team kill command
function cmdTeamKill(name) {
  const teamsData = loadTeams();
  
  if (!teamsData.teams[name]) {
    console.error(`❌ Error: Team "${name}" not found`);
    process.exit(1);
  }
  
  const team = teamsData.teams[name];
  team.status = 'stopped';
  team.stoppedAt = new Date().toISOString();
  
  teamsData.teams[name] = team;
  saveTeams(teamsData);
  
  console.log(`✅ Team "${name}" stopped`);
  console.log(`   Session key: ${team.sessionKey}`);
  console.log('\n💡 Use "openclaw sessions cleanup" to remove session data');
}

// Send message command
function cmdSend(target, message) {
  if (!target || !message) {
    console.error('❌ Error: Usage: send <agent|team> <message>');
    process.exit(1);
  }
  
  const teamsData = loadTeams();
  
  // Check if target is a team
  if (teamsData.teams[target]) {
    const team = teamsData.teams[target];
    console.log(`📤 Broadcasting to team "${target}"...`);
    console.log(`   Message: ${message}`);
    console.log(`   Recipients: ${team.members?.map(m => m.agentId).join(', ')}`);
    console.log('\n💡 Use sessions_send tool to actually send messages');
  } else {
    // Target is an agent
    console.log(`📤 Sending to agent "${target}"...`);
    console.log(`   Message: ${message}`);
    console.log('\n💡 Use sessions_send tool to actually send messages');
  }
}

// Spawn command
function cmdSpawn(agentId, task, options) {
  if (!agentId || !task) {
    console.error('❌ Error: Usage: spawn <agent> <task>');
    process.exit(1);
  }
  
  console.log('🚀 Spawning agent session...');
  console.log(`   Agent: ${agentId}`);
  console.log(`   Task: ${task}`);
  console.log(`   Model: ${options.model || 'default'}`);
  console.log(`   Thread: ${options.thread ? 'Yes' : 'No'}`);
  console.log(`   Persistent: ${options.persistent ? 'Yes' : 'No'}`);
  console.log('\n💡 Use sessions_spawn tool to actually spawn the session');
}

// Sessions list command
function cmdSessionsList() {
  const sessions = getSessionsList(120);
  const officeSessions = sessions.sessions?.filter(s => 
    s.key?.includes(':office:') || s.key?.includes('subagent')
  ) || [];
  
  console.log('\n📋 Office Sessions:\n');
  
  if (officeSessions.length === 0) {
    console.log('  No active office sessions');
  } else {
    officeSessions.forEach(session => {
      console.log(`• ${session.key}`);
      console.log(`  Model: ${session.model || 'N/A'}`);
      console.log(`  Updated: ${session.updatedAt || 'N/A'}`);
      console.log('');
    });
  }
}

// Main entry point
function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command) {
    console.log('Office CLI - Multi-Agent Team Management');
    console.log('\nUsage: node office-cli.js <command> [options]');
    console.log('\nCommands:');
    console.log('  dashboard              Show agent and team dashboard');
    console.log('  team create <name>     Create a new team');
    console.log('  team list              List all teams');
    console.log('  team info <name>       Show team details');
    console.log('  team kill <name>       Stop a team');
    console.log('  send <target> <msg>    Send message to agent/team');
    console.log('  spawn <agent> <task>   Spawn agent session');
    console.log('  sessions list          List office sessions');
    console.log('\nExamples:');
    console.log('  node office-cli.js dashboard');
    console.log('  node office-cli.js team create dev-team --agents codex,claude');
    console.log('  node office-cli.js team list');
    console.log('');
    return;
  }
  
  // Parse command-specific args
  const options = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--agents' && args[i + 1]) {
      options.agents = args[++i];
    } else if (args[i] === '--orchestrator' && args[i + 1]) {
      options.orchestrator = args[++i];
    } else if (args[i] === '--model' && args[i + 1]) {
      options.model = args[++i];
    } else if (args[i] === '--thread') {
      options.thread = true;
    } else if (args[i] === '--persistent') {
      options.persistent = true;
    } else if (args[i] === '--active') {
      options.active = true;
    } else if (args[i] === '--json') {
      options.json = true;
    }
  }
  
  switch (command) {
    case 'dashboard':
      cmdDashboard(options);
      break;
    case 'team':
      const teamCmd = args[1];
      const teamName = args[2];
      if (teamCmd === 'create') {
        cmdTeamCreate(teamName, options);
      } else if (teamCmd === 'list') {
        cmdTeamList();
      } else if (teamCmd === 'info') {
        cmdTeamInfo(teamName);
      } else if (teamCmd === 'kill') {
        cmdTeamKill(teamName);
      } else {
        console.error(`Unknown team command: ${teamCmd}`);
      }
      break;
    case 'send':
      cmdSend(args[1], args.slice(2).join(' '));
      break;
    case 'spawn':
      cmdSpawn(args[1], args.slice(2).join(' '), options);
      break;
    case 'sessions':
      if (args[1] === 'list') {
        cmdSessionsList();
      }
      break;
    default:
      console.error(`Unknown command: ${command}`);
  }
}

main();
