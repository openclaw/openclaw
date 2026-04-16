#!/usr/bin/env node
/**
 * Cron setup for Agent Runbook Generator
 * 
 * Creates a cron job to automatically update the runbook on a schedule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CronJob {
  schedule: string;
  command: string;
  description: string;
}

class CronSetup {
  private projectRoot: string;
  private generatorPath: string;
  
  constructor() {
    this.projectRoot = path.join(__dirname, '../..');
    this.generatorPath = path.join(__dirname, 'generator.ts');
  }
  
  /**
   * Generate cron job entry
   */
  generateCronJob(schedule: string = '0 * * * *'): CronJob {
    const command = `cd "${this.projectRoot}" && node "${this.generatorPath}"`;
    
    return {
      schedule,
      command,
      description: 'Update Agent Runbook'
    };
  }
  
  /**
   * Create cron job file
   */
  createCronFile(jobs: CronJob[]): string {
    let cronContent = `# Agent Runbook Generator Cron Jobs
# Automatically generated - do not edit manually
# Generated: ${new Date().toISOString()}

`;
    
    for (const job of jobs) {
      cronContent += `# ${job.description}
${job.schedule} ${job.command}

`;
    }
    
    return cronContent;
  }
  
  /**
   * Install cron job (Linux/macOS)
   */
  installCron(jobs: CronJob[]): void {
    const cronContent = this.createCronFile(jobs);
    const cronFilePath = path.join(__dirname, 'cron-jobs.txt');
    
    // Save cron file
    fs.writeFileSync(cronFilePath, cronContent);
    console.log(`Cron jobs saved to: ${cronFilePath}`);
    
    // Instructions for installation
    console.log(`
To install the cron jobs:

1. View the generated cron jobs:
   cat ${cronFilePath}

2. Install to your crontab:
   crontab ${cronFilePath}

3. Or append to existing crontab:
   cat ${cronFilePath} >> /tmp/my-cron
   crontab /tmp/my-cron

Alternative schedules:
- Every hour: "0 * * * *"
- Every 6 hours: "0 */6 * * *"  
- Daily at 2 AM: "0 2 * * *"
- Every Monday at 3 AM: "0 3 * * 1"
`);
  }
  
  /**
   * Create systemd timer (Linux with systemd)
   */
  createSystemdTimer(): void {
    const serviceName = 'agent-runbook-generator';
    const serviceContent = `[Unit]
Description=Agent Runbook Generator
After=network.target

[Service]
Type=oneshot
ExecStart=${process.execPath} ${this.generatorPath}
WorkingDirectory=${this.projectRoot}
User=${process.env.USER || 'root'}

[Install]
WantedBy=multi-user.target
`;
    
    const timerContent = `[Unit]
Description=Run Agent Runbook Generator hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
`;
    
    const servicePath = `/etc/systemd/system/${serviceName}.service`;
    const timerPath = `/etc/systemd/system/${serviceName}.timer`;
    
    console.log(`
For systemd-based systems, create these files:

${serviceName}.service:
${serviceContent}

${serviceName}.timer:
${timerContent}

Then enable and start:
sudo systemctl daemon-reload
sudo systemctl enable ${serviceName}.timer
sudo systemctl start ${serviceName}.timer
`);
  }
  
  /**
   * Create Windows Task Scheduler XML
   */
  createWindowsTask(): void {
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${new Date().toISOString()}</Date>
    <Author>OpenClaw</Author>
    <Description>Agent Runbook Generator - Updates runbook hourly</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${new Date().toISOString().split('T')[0]}T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>${process.execPath}</Command>
      <Arguments>"${this.generatorPath}"</Arguments>
      <WorkingDirectory>"${this.projectRoot}"</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
    
    console.log(`
For Windows Task Scheduler:

1. Save this XML to a file (e.g., agent-runbook-task.xml):
${taskXml}

2. Import the task:
   schtasks /Create /XML agent-runbook-task.xml /TN "OpenClaw Agent Runbook Generator"

3. Or create manually:
   - Open Task Scheduler
   - Create Basic Task
   - Name: "OpenClaw Agent Runbook Generator"
   - Trigger: Daily
   - Action: Start a program
   - Program: ${process.execPath}
   - Arguments: "${this.generatorPath}"
   - Start in: "${this.projectRoot}"
`);
  }
  
  /**
   * Show setup instructions based on OS
   */
  showInstructions(): void {
    const jobs = [
      this.generateCronJob('0 * * * *'), // Every hour
      this.generateCronJob('0 2 * * *'), // Daily at 2 AM
    ];
    
    console.log('=== Agent Runbook Generator - Scheduling Setup ===\n');
    
    const platform = process.platform;
    
    if (platform === 'linux' || platform === 'darwin') {
      console.log('Unix-like system detected (Linux/macOS)\n');
      this.installCron(jobs);
      
      if (platform === 'linux') {
        console.log('\n--- Alternative: systemd timer ---');
        this.createSystemdTimer();
      }
    } else if (platform === 'win32') {
      console.log('Windows detected\n');
      this.createWindowsTask();
    } else {
      console.log(`Unsupported platform: ${platform}`);
      console.log('Manual cron job setup required.');
      this.installCron(jobs);
    }
    
    console.log('\n=== Quick Test ===');
    console.log('Test the generator manually:');
    console.log(`  cd "${this.projectRoot}"`);
    console.log(`  node "${this.generatorPath}"`);
  }
  
  /**
   * Main execution
   */
  run(): void {
    this.showInstructions();
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const setup = new CronSetup();
  setup.run();
}

export { CronSetup };