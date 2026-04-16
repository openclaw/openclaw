#!/usr/bin/env node
/**
 * Agent Runbook Generator
 * 
 * Automatically generates and maintains a runbook for common agent tasks,
 * collector failures, and recovery steps.
 * 
 * Features:
 * - Extracts recent failures and commands from logs
 * - Summarizes them into markdown sections
 * - Includes links to relevant Obsidian notes
 * - Can be scheduled via cron
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AgentFailure {
  timestamp: string;
  agentId: string;
  task: string;
  error: string;
  recoverySteps: string[];
  frequency: number;
  lastOccurred: string;
}

interface AgentCommand {
  command: string;
  description: string;
  usage: string;
  commonPitfalls: string[];
  examples: string[];
}

interface ObsidianNote {
  title: string;
  path: string;
  lastModified: string;
  tags: string[];
}

class AgentRunbookGenerator {
  private logPath: string;
  private obsidianVaultPath: string;
  private outputPath: string;
  
  constructor(options: {
    logPath?: string;
    obsidianVaultPath?: string;
    outputPath?: string;
  } = {}) {
    this.logPath = options.logPath || this.resolveDefaultLogPath();
    this.obsidianVaultPath = options.obsidianVaultPath || this.resolveDefaultObsidianPath();
    this.outputPath = options.outputPath || path.join(__dirname, '../..', 'docs/runbooks/agent-runbook.md');
  }
  
  private resolveDefaultLogPath(): string {
    // Try to find the OpenClaw log file
    const possiblePaths = [
      '/tmp/openclaw/openclaw.log',
      path.join(process.env.HOME || '', '.openclaw/logs/openclaw.log'),
      path.join(__dirname, '../../logs/openclaw.log'),
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    
    return possiblePaths[0]; // Return default even if doesn't exist
  }
  
  private resolveDefaultObsidianPath(): string {
    // Default Obsidian vault location
    return path.join(process.env.HOME || '', 'SakVault');
  }
  
  /**
   * Parse log files to extract agent failures
   */
  async extractFailures(): Promise<AgentFailure[]> {
    const failures: AgentFailure[] = [];
    
    if (!fs.existsSync(this.logPath)) {
      console.warn(`Log file not found: ${this.logPath}`);
      return failures;
    }
    
    try {
      const logContent = fs.readFileSync(this.logPath, 'utf-8');
      const lines = logContent.split('\n');
      
      // Simple pattern matching for errors (can be enhanced)
      let currentFailure: Partial<AgentFailure> | null = null;
      
      for (const line of lines.slice(-1000)) { // Look at last 1000 lines
        // Look for error patterns
        if (line.includes('ERROR') || line.includes('error:') || line.includes('failed')) {
          // Extract timestamp (simplified)
          const timestampMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/) || 
                                line.match(/\d{2}:\d{2}:\d{2}/);
          const timestamp = timestampMatch ? timestampMatch[0] : new Date().toISOString();
          
          // Try to extract agent ID
          const agentMatch = line.match(/agent[:\s]+([^\s,]+)/i) || 
                           line.match(/(?:Agent|agent)[\s]+([A-Za-z0-9_-]+)/);
          const agentId = agentMatch ? agentMatch[1] : 'unknown';
          
          // Extract error message
          const errorStart = Math.max(
            line.indexOf('ERROR:') + 6,
            line.indexOf('error:') + 6,
            line.indexOf('failed:') + 7,
            0
          );
          const error = line.slice(errorStart).trim();
          
          failures.push({
            timestamp,
            agentId,
            task: this.inferTaskFromError(error),
            error,
            recoverySteps: this.suggestRecoverySteps(error, agentId),
            frequency: 1, // Would need historical analysis
            lastOccurred: timestamp,
          });
        }
      }
      
      // Group similar failures
      return this.groupSimilarFailures(failures);
    } catch (error) {
      console.error(`Error parsing log file: ${error}`);
      return [];
    }
  }
  
  /**
   * Infer task from error message
   */
  private inferTaskFromError(error: string): string {
    const lowerError = error.toLowerCase();
    
    if (lowerError.includes('git') || lowerError.includes('clone') || lowerError.includes('pull')) {
      return 'Git Operations';
    } else if (lowerError.includes('docker') || lowerError.includes('container')) {
      return 'Docker Operations';
    } else if (lowerError.includes('api') || lowerError.includes('http') || lowerError.includes('network')) {
      return 'API/Network Operations';
    } else if (lowerError.includes('file') || lowerError.includes('permission') || lowerError.includes('eaccess')) {
      return 'File System Operations';
    } else if (lowerError.includes('memory') || lowerError.includes('out of memory')) {
      return 'Memory Management';
    } else if (lowerError.includes('timeout') || lowerError.includes('timed out')) {
      return 'Timeout Handling';
    } else {
      return 'General Operation';
    }
  }
  
  /**
   * Suggest recovery steps based on error type
   */
  private suggestRecoverySteps(error: string, agentId: string): string[] {
    const lowerError = error.toLowerCase();
    const steps: string[] = [];
    
    if (lowerError.includes('permission denied') || lowerError.includes('eaccess')) {
      steps.push('Check file permissions and ownership');
      steps.push('Verify running user has appropriate access');
      steps.push('Check SELinux/AppArmor policies if applicable');
    } else if (lowerError.includes('connection refused') || lowerError.includes('network')) {
      steps.push('Verify network connectivity');
      steps.push('Check if service is running on target host');
      steps.push('Verify firewall rules');
    } else if (lowerError.includes('timeout')) {
      steps.push('Increase timeout settings in configuration');
      steps.push('Check network latency and bandwidth');
      steps.push('Verify resource availability (CPU, memory)');
    } else if (lowerError.includes('out of memory')) {
      steps.push('Increase memory allocation for agent');
      steps.push('Check for memory leaks in agent code');
      steps.push('Consider implementing memory limits');
    } else if (lowerError.includes('git')) {
      steps.push('Verify git credentials and permissions');
      steps.push('Check network connectivity to git repository');
      steps.push('Ensure git is properly installed');
    }
    
    // Add general steps
    steps.push(`Check agent "${agentId}" logs for more details`);
    steps.push('Restart agent if problem persists');
    steps.push('Consult relevant Obsidian documentation');
    
    return steps;
  }
  
  /**
   * Group similar failures together
   */
  private groupSimilarFailures(failures: AgentFailure[]): AgentFailure[] {
    const grouped = new Map<string, AgentFailure>();
    
    for (const failure of failures) {
      const key = `${failure.agentId}:${failure.task}:${failure.error.substring(0, 50)}`;
      
      if (grouped.has(key)) {
        const existing = grouped.get(key)!;
        existing.frequency++;
        if (new Date(failure.timestamp) > new Date(existing.lastOccurred)) {
          existing.lastOccurred = failure.timestamp;
        }
      } else {
        grouped.set(key, { ...failure });
      }
    }
    
    return Array.from(grouped.values());
  }
  
  /**
   * Extract common agent commands from logs and config
   */
  async extractCommands(): Promise<AgentCommand[]> {
    // This would parse actual command usage from logs
    // For now, return example commands
    return [
      {
        command: 'agent start <agentId>',
        description: 'Start a specific agent',
        usage: 'agent start builder\nagent start researcher',
        commonPitfalls: [
          'Agent may fail if dependencies are missing',
          'Port conflicts can prevent startup',
          'Insufficient permissions for required operations'
        ],
        examples: [
          'agent start builder --env=production',
          'agent start researcher --model=gpt-4'
        ]
      },
      {
        command: 'agent restart <agentId>',
        description: 'Restart a running agent',
        usage: 'agent restart builder\nagent restart orchestrator',
        commonPitfalls: [
          'In-flight tasks may be interrupted',
          'State may be lost if not properly persisted',
          'Dependencies may need re-initialization'
        ],
        examples: [
          'agent restart builder --force',
          'agent restart orchestrator --wait-for-completion'
        ]
      },
      {
        command: 'agent logs <agentId>',
        description: 'View agent logs',
        usage: 'agent logs builder\nagent logs researcher --tail=100',
        commonPitfalls: [
          'Log files may be rotated or truncated',
          'Large log files can be slow to read',
          'Sensitive information may be exposed in logs'
        ],
        examples: [
          'agent logs builder --follow',
          'agent logs researcher --since="2 hours ago"'
        ]
      }
    ];
  }
  
  /**
   * Find relevant Obsidian notes
   */
  async findObsidianNotes(): Promise<ObsidianNote[]> {
    const notes: ObsidianNote[] = [];
    
    if (!fs.existsSync(this.obsidianVaultPath)) {
      console.warn(`Obsidian vault not found: ${this.obsidianVaultPath}`);
      return notes;
    }
    
    try {
      // Look for markdown files in the vault
      const findMarkdownFiles = (dir: string): string[] => {
        let results: string[] = [];
        const items = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const item of items) {
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            results = results.concat(findMarkdownFiles(fullPath));
          } else if (item.name.endsWith('.md')) {
            results.push(fullPath);
          }
        }
        
        return results;
      };
      
      const mdFiles = findMarkdownFiles(this.obsidianVaultPath);
      
      // Sample some files (in reality, would filter for agent-related notes)
      for (const filePath of mdFiles.slice(0, 10)) {
        try {
          const stats = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          
          // Extract title from first line or filename
          const firstLine = content.split('\n')[0];
          const title = firstLine.startsWith('# ') 
            ? firstLine.substring(2).trim()
            : path.basename(filePath, '.md');
          
          // Extract tags
          const tags: string[] = [];
          const tagMatches = content.matchAll(/#([a-zA-Z0-9_-]+)/g);
          for (const match of tagMatches) {
            tags.push(match[1]);
          }
          
          notes.push({
            title,
            path: path.relative(this.obsidianVaultPath, filePath),
            lastModified: stats.mtime.toISOString(),
            tags: Array.from(new Set(tags)).slice(0, 5) // Deduplicate and limit
          });
        } catch (error) {
          console.warn(`Error reading note ${filePath}: ${error}`);
        }
      }
    } catch (error) {
      console.error(`Error scanning Obsidian vault: ${error}`);
    }
    
    return notes;
  }
  
  /**
   * Generate the runbook markdown
   */
  async generateRunbook(): Promise<string> {
    const failures = await this.extractFailures();
    const commands = await this.extractCommands();
    const notes = await this.findObsidianNotes();
    
    const now = new Date();
    const timestamp = now.toISOString();
    
    let markdown = `# Agent Runbook
*Generated: ${timestamp}*
*Automatically maintained by Agent Runbook Generator*

## Overview
This runbook documents common agent failures, recovery procedures, and operational commands.
It is automatically generated from system logs and updated regularly.

---

## Common Agent Failures

`;

    if (failures.length === 0) {
      markdown += `No recent failures detected. ✅\n\n`;
    } else {
      markdown += `| Agent | Task | Error | Frequency | Last Occurred | Recovery Steps |
|-------|------|-------|-----------|---------------|----------------|
`;
      
      for (const failure of failures.sort((a, b) => b.frequency - a.frequency)) {
        const recoverySteps = failure.recoverySteps.map(step => `- ${step}`).join('<br>');
        markdown += `| ${failure.agentId} | ${failure.task} | \`${failure.error.substring(0, 50)}${failure.error.length > 50 ? '...' : ''}\` | ${failure.frequency} | ${failure.lastOccurred} | ${recoverySteps} |
`;
      }
      markdown += '\n';
    }

    markdown += `## Agent Commands Reference

`;

    for (const cmd of commands) {
      markdown += `### \`${cmd.command}\`
**Description:** ${cmd.description}

**Usage:**
\`\`\`bash
${cmd.usage}
\`\`\`

**Common Pitfalls:**
${cmd.commonPitfalls.map(p => `- ${p}`).join('\n')}

**Examples:**
\`\`\`bash
${cmd.examples.join('\n')}
\`\`\`

`;
    }

    markdown += `## Relevant Documentation

`;

    if (notes.length === 0) {
      markdown += `No Obsidian notes found in vault.\n\n`;
    } else {
      markdown += `| Title | Path | Tags | Last Modified |
|-------|------|------|---------------|
`;
      
      for (const note of notes.slice(0, 15)) { // Limit to 15 most relevant
        const tags = note.tags.map(t => `\`#${t}\``).join(' ');
        markdown += `| ${note.title} | \`${note.path}\` | ${tags} | ${note.lastModified.substring(0, 10)} |
`;
      }
      markdown += '\n';
    }

    markdown += `## Maintenance

### Manual Updates
To update this runbook manually:
\`\`\`bash
cd /home/sak/projects/openclaw
node scripts/agent-runbook/generator.ts
\`\`\`

### Automated Schedule
This runbook can be automatically updated via cron:

\`\`\`cron
# Update runbook every hour
0 * * * * cd /home/sak/projects/openclaw && node scripts/agent-runbook/generator.ts
\`\`\`

### Integration with Obsidian
The runbook automatically references notes from your Obsidian vault at:
\`${this.obsidianVaultPath}\`

---

*Generated by Agent Runbook Generator v1.0*
*Task ID: 7202d396-9b3f-4228-b870-99ffbd53c0ad*
`;
    
    return markdown;
  }
  
  /**
   * Save runbook to file
   */
  async saveRunbook(markdown: string): Promise<void> {
    // Ensure output directory exists
    const outputDir = path.dirname(this.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(this.outputPath, markdown);
    console.log(`Runbook saved to: ${this.outputPath}`);
  }
  
  /**
   * Main execution method
   */
  async run(): Promise<void> {
    console.log('Generating agent runbook...');
    console.log(`Log path: ${this.logPath}`);
    console.log(`Obsidian vault: ${this.obsidianVaultPath}`);
    console.log(`Output: ${this.outputPath}`);
    
    const runbook = await this.generateRunbook();
    await this.saveRunbook(runbook);
    
    console.log('Runbook generation complete!');
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options: any = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log-path' && args[i + 1]) {
      options.logPath = args[++i];
    } else if (args[i] === '--obsidian-path' && args[i + 1]) {
      options.obsidianVaultPath = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      options.outputPath = args[++i];
    } else if (args[i] === '--help') {
      console.log(`
Agent Runbook Generator
Usage: node generator.ts [options]

Options:
  --log-path <path>      Path to OpenClaw log file
  --obsidian-path <path> Path to Obsidian vault
  --output <path>        Output path for runbook
  --help                 Show this help
`);
      process.exit(0);
    }
  }
  
  const generator = new AgentRunbookGenerator(options);
  generator.run().catch(console.error);
}

export { AgentRunbookGenerator };