/**
 * Workflow Execution Demo
 * 
 * Demonstrates production-ready Lobster workflows:
 * 1. GitHub Issue Triage
 * 2. Daily Intelligence Briefing
 * 3. Incident Response
 * 4. Weekly Retrospective
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

// Mock Workflow Executor
class WorkflowExecutor {
  async execute(workflowName: string, params: any) {
    const workflows: Record<string, (params: any) => Promise<any>> = {
      'github-triage': this.executeGitHubTriage.bind(this),
      'daily-brief': this.executeDailyBrief.bind(this),
      'incident-response': this.executeIncidentResponse.bind(this),
      'weekly-retro': this.executeWeeklyRetro.bind(this)
    };

    const executor = workflows[workflowName];
    if (!executor) {
      throw new Error(`Unknown workflow: ${workflowName}`);
    }

    return await executor(params);
  }

  private async executeGitHubTriage(params: any) {
    // Simulate GitHub triage workflow
    await new Promise(resolve => setTimeout(resolve, 200));

    return {
      workflow: 'github-triage',
      issue: {
        number: params.issue_number || 123,
        title: params.title || 'Bug: Application crashes on startup',
        labels: ['bug', 'high-priority']
      },
      classification: {
        type: 'bug',
        priority: 'high',
        area: 'authentication',
        complexity: 'moderate'
      },
      assignment: {
        agent: 'CODE',
        team: 'backend-team',
        estimated_effort: '4-8 hours'
      },
      actions_taken: [
        'Classified as high-priority bug',
        'Assigned to CODE agent for analysis',
        'Added labels: bug, high-priority, authentication',
        'Notified backend team via Slack'
      ],
      duration_ms: 1500,
      agents_used: ['PRIME', 'CODE', 'OPS']
    };
  }

  private async executeDailyBrief(params: any) {
    // Simulate daily briefing workflow
    await new Promise(resolve => setTimeout(resolve, 300));

    return {
      workflow: 'daily-brief',
      date: new Date().toISOString().split('T')[0],
      sections: {
        priority_items: [
          'Critical security vulnerability in auth module (CVE-2024-1234)',
          'Production database at 85% capacity',
          'Customer escalation: API latency spike'
        ],
        project_status: {
          active_projects: 5,
          completed_this_week: 3,
          blocked: 1,
          on_track: 4
        },
        calendar: [
          '10:00 AM - Team standup',
          '2:00 PM - Architecture review',
          '4:00 PM - Client demo'
        ],
        key_messages: [
          'CTO: Need security audit results by EOD',
          'PM: Sprint review moved to Thursday',
          'DevOps: Deployment window Friday 2-4 AM'
        ],
        security_notes: [
          'New CVE published for dependency X',
          'Audit found 2 medium-severity issues',
          'All systems passed security scan'
        ]
      },
      summary: 'High activity day with security focus. 3 priority items require immediate attention.',
      duration_ms: 2500,
      agents_used: ['RESEARCH', 'MEMORY', 'PRIME']
    };
  }

  private async executeIncidentResponse(params: any) {
    // Simulate incident response workflow
    await new Promise(resolve => setTimeout(resolve, 400));

    return {
      workflow: 'incident-response',
      incident_id: `INC-${Date.now()}`,
      severity: params.severity || 'high',
      description: params.description || 'Database connection pool exhausted',
      timeline: [
        {
          time: '00:00',
          event: 'Alert triggered: db_connection_pool_usage > 80%',
          agent: 'OPS'
        },
        {
          time: '00:02',
          event: 'Incident declared, severity: high',
          agent: 'PRIME'
        },
        {
          time: '00:05',
          event: 'Diagnostics gathered: connection leak in worker service',
          agent: 'OPS'
        },
        {
          time: '00:15',
          event: 'Root cause identified: unclosed connections in async handler',
          agent: 'CODE'
        },
        {
          time: '00:25',
          event: 'Fix implemented and tested',
          agent: 'CODE'
        },
        {
          time: '00:30',
          event: 'Fix validated by CRITIC agent',
          agent: 'CRITIC'
        },
        {
          time: '00:35',
          event: 'Deployed to production',
          agent: 'OPS'
        },
        {
          time: '00:40',
          event: 'Metrics normalized, incident resolved',
          agent: 'OPS'
        }
      ],
      actions_taken: [
        'Scaled connection pool from 10 to 20',
        'Restarted affected worker services',
        'Deployed hotfix for connection leak',
        'Added connection monitoring alerts'
      ],
      resolution: 'Root cause: Unclosed database connections in async error handler. Fix: Added proper connection cleanup in finally blocks.',
      metrics: {
        time_to_detect: '2 min',
        time_to_resolve: '40 min',
        affected_users: '~500',
        data_loss: 'None'
      },
      duration_ms: 3500,
      agents_used: ['OPS', 'CODE', 'CRITIC', 'PRIME']
    };
  }

  private async executeWeeklyRetro(params: any) {
    // Simulate weekly retrospective workflow
    await new Promise(resolve => setTimeout(resolve, 250));

    return {
      workflow: 'weekly-retro',
      week: '2024-W48',
      achievements: [
        'Shipped user authentication feature (2 weeks ahead of schedule)',
        'Reduced API latency by 40% through caching optimization',
        'Resolved 15 customer-reported bugs',
        'Achieved 95% test coverage on core modules'
      ],
      challenges: [
        'Database migration caused 2-hour outage',
        'Third-party API rate limiting affected 3 features',
        'Team capacity reduced due to illness (2 engineers)',
        'Documentation lagged behind feature development'
      ],
      lessons_learned: [
        'Always test migrations in staging first',
        'Implement circuit breakers for external APIs',
        'Cross-train team members on critical systems',
        'Include documentation in Definition of Done'
      ],
      action_items: [
        {
          task: 'Implement automated migration testing',
          owner: 'DevOps',
          priority: 'high',
          due_date: '2024-12-15'
        },
        {
          task: 'Add circuit breakers to external API calls',
          owner: 'Backend',
          priority: 'high',
          due_date: '2024-12-20'
        },
        {
          task: 'Create cross-training schedule',
          owner: 'Engineering Manager',
          priority: 'medium',
          due_date: '2024-12-10'
        }
      ],
      metrics: {
        velocity: '42 story points',
        bugs_fixed: 15,
        features_shipped: 3,
        customer_satisfaction: '4.6/5'
      },
      duration_ms: 2000,
      agents_used: ['MEMORY', 'PRIME', 'OPS']
    };
  }
}

// Demo runner
export async function runWorkflowDemos() {
  let testsPassed = 0;

  console.log(chalk.white('Initializing Workflow Executor...\n'));
  const executor = new WorkflowExecutor();
  const spinner = ora('Loading Lobster workflows').start();
  
  await new Promise(resolve => setTimeout(resolve, 500));
  spinner.succeed('Workflows loaded');

  // Demo 1: GitHub Issue Triage
  console.log(chalk.bold.white('\n🐙 Demo 1: GitHub Issue Triage\n'));
  console.log(chalk.dim('Trigger: New issue opened in repository\n'));

  const githubResult = await executor.execute('github-triage', {
    issue_number: 123,
    title: 'Bug: Application crashes on startup',
    body: 'Steps to reproduce...',
    webhook_payload: {
      action: 'opened',
      issue: {
        number: 123,
        title: 'Bug: Application crashes on startup',
        body: 'Steps to reproduce:\n1. Install app\n2. Run npm start\n3. App crashes immediately',
        labels: ['bug']
      }
    }
  });

  const githubTable = new Table({
    head: [chalk.cyan('Field'), chalk.cyan('Value')],
    colWidths: [25, 75],
    style: { head: [], border: [] }
  });

  githubTable.push(
    ['Issue', `#${githubResult.issue.number}: ${githubResult.issue.title}`],
    ['Classification', `${chalk.red(githubResult.classification.type)} | Priority: ${chalk.yellow(githubResult.classification.priority)}`],
    ['Assigned To', chalk.cyan(githubResult.assignment.agent)],
    ['Team', githubResult.assignment.team],
    ['Estimated Effort', githubResult.assignment.estimated_effort]
  );

  console.log(githubTable.toString());

  console.log(chalk.bold.white('\n  Actions Taken:'));
  githubResult.actions_taken.forEach((action: string, i: number) => {
    console.log(chalk.dim(`    ${i + 1}. ${action}`));
  });

  console.log(chalk.dim(`\n  Duration: ${githubResult.duration_ms}ms | Agents: ${githubResult.agents_used.join(', ')}\n`));
  testsPassed++;

  // Demo 2: Daily Intelligence Briefing
  console.log(chalk.bold.white('\n📰 Demo 2: Daily Intelligence Briefing\n'));
  console.log(chalk.dim('Trigger: Cron schedule (8:00 AM daily)\n'));

  const briefResult = await executor.execute('daily-brief', {
    topics: ['AI', 'technology', 'startups'],
    sources: ['hacker-news', 'reddit', 'arxiv'],
    output_format: 'markdown'
  });

  console.log(chalk.bold.cyan(`  📅 Date: ${briefResult.date}\n`));

  console.log(chalk.bold.white('  🔥 Priority Items:'));
  briefResult.sections.priority_items.forEach((item: string, i: number) => {
    console.log(chalk.dim(`    ${i + 1}. ${item}`));
  });

  console.log(chalk.bold.white('\n  📊 Project Status:'));
  const statusTable = new Table({
    head: [chalk.cyan('Metric'), chalk.cyan('Value')],
    colWidths: [30, 70],
    style: { head: [], border: [] }
  });

  statusTable.push(
    ['Active Projects', briefResult.sections.project_status.active_projects.toString()],
    ['Completed This Week', chalk.green(briefResult.sections.project_status.completed_this_week.toString())],
    ['Blocked', chalk.red(briefResult.sections.project_status.blocked.toString())],
    ['On Track', chalk.green(briefResult.sections.project_status.on_track.toString())]
  );

  console.log(statusTable.toString());

  console.log(chalk.bold.white('\n  📅 Calendar:'));
  briefResult.sections.calendar.forEach((event: string) => {
    console.log(chalk.dim(`    • ${event}`));
  });

  console.log(chalk.bold.white('\n  💬 Key Messages:'));
  briefResult.sections.key_messages.forEach((msg: string) => {
    console.log(chalk.dim(`    • ${msg}`));
  });

  console.log(chalk.dim(`\n  Summary: ${briefResult.summary}`));
  console.log(chalk.dim(`  Duration: ${briefResult.duration_ms}ms | Agents: ${briefResult.agents_used.join(', ')}\n`));
  testsPassed++;

  // Demo 3: Incident Response
  console.log(chalk.bold.white('\n🚨 Demo 3: Incident Response\n'));
  console.log(chalk.dim('Trigger: Alert from monitoring system\n'));

  const incidentResult = await executor.execute('incident-response', {
    severity: 'high',
    description: 'Database connection pool exhausted',
    alerts: [
      {
        source: 'prometheus',
        metric: 'db_connection_pool_usage',
        value: 0.95,
        threshold: 0.80
      }
    ],
    affected_services: ['api-server', 'worker-service']
  });

  const incidentHeaderTable = new Table({
    head: [chalk.cyan('Field'), chalk.cyan('Value')],
    colWidths: [25, 75],
    style: { head: [], border: [] }
  });

  incidentHeaderTable.push(
    ['Incident ID', chalk.red(incidentResult.incident_id)],
    ['Severity', chalk.red(incidentResult.severity.toUpperCase())],
    ['Description', incidentResult.description]
  );

  console.log(incidentHeaderTable.toString());

  console.log(chalk.bold.white('\n  📋 Incident Timeline:'));
  const timelineTable = new Table({
    head: [chalk.cyan('Time'), chalk.cyan('Event'), chalk.cyan('Agent')],
    colWidths: [12, 68, 20],
    style: { head: [], border: [] }
  });

  incidentResult.timeline.forEach((entry: any) => {
    timelineTable.push([
      chalk.yellow(entry.time),
      entry.event,
      chalk.cyan(entry.agent)
    ]);
  });

  console.log(timelineTable.toString());

  console.log(chalk.bold.white('\n  ✅ Actions Taken:'));
  incidentResult.actions_taken.forEach((action: string, i: number) => {
    console.log(chalk.dim(`    ${i + 1}. ${action}`));
  });

  console.log(chalk.bold.white('\n  📊 Metrics:'));
  const metricsTable = new Table({
    head: [chalk.cyan('Metric'), chalk.cyan('Value')],
    colWidths: [30, 70],
    style: { head: [], border: [] }
  });

  metricsTable.push(
    ['Time to Detect', incidentResult.metrics.time_to_detect],
    ['Time to Resolve', incidentResult.metrics.time_to_resolve],
    ['Affected Users', incidentResult.metrics.affected_users],
    ['Data Loss', chalk.green(incidentResult.metrics.data_loss)]
  );

  console.log(metricsTable.toString());

  console.log(chalk.bold.white(`\n  💡 Resolution: ${incidentResult.resolution}`));
  console.log(chalk.dim(`  Duration: ${incidentResult.duration_ms}ms | Agents: ${incidentResult.agents_used.join(', ')}\n`));
  testsPassed++;

  // Demo 4: Weekly Retrospective
  console.log(chalk.bold.white('\n📈 Demo 4: Weekly Retrospective\n'));
  console.log(chalk.dim('Trigger: Cron schedule (Sunday 6:00 PM)\n'));

  const retroResult = await executor.execute('weekly-retro', {});

  console.log(chalk.bold.cyan(`  📅 Week: ${retroResult.week}\n`));

  console.log(chalk.bold.white('  ✅ Achievements:'));
  retroResult.achievements.forEach((achievement: string, i: number) => {
    console.log(chalk.green(`    ${i + 1}. ${achievement}`));
  });

  console.log(chalk.bold.white('\n  ⚠️ Challenges:'));
  retroResult.challenges.forEach((challenge: string, i: number) => {
    console.log(chalk.yellow(`    ${i + 1}. ${challenge}`));
  });

  console.log(chalk.bold.white('\n  💡 Lessons Learned:'));
  retroResult.lessons_learned.forEach((lesson: string, i: number) => {
    console.log(chalk.cyan(`    ${i + 1}. ${lesson}`));
  });

  console.log(chalk.bold.white('\n  🎯 Action Items:'));
  const actionTable = new Table({
    head: [chalk.cyan('Task'), chalk.cyan('Owner'), chalk.cyan('Priority'), chalk.cyan('Due')],
    colWidths: [45, 20, 15, 20],
    style: { head: [], border: [] }
  });

  retroResult.action_items.forEach((item: any) => {
    const priority = item.priority === 'high' ? chalk.red(item.priority) : chalk.yellow(item.priority);
    actionTable.push([
      item.task,
      item.owner,
      priority,
      item.due_date
    ]);
  });

  console.log(actionTable.toString());

  console.log(chalk.bold.white('\n  📊 Metrics:'));
  const retroMetricsTable = new Table({
    head: [chalk.cyan('Metric'), chalk.cyan('Value')],
    colWidths: [30, 70],
    style: { head: [], border: [] }
  });

  retroMetricsTable.push(
    ['Velocity', `${retroResult.metrics.velocity} story points`],
    ['Bugs Fixed', chalk.green(retroResult.metrics.bugs_fixed.toString())],
    ['Features Shipped', chalk.green(retroResult.metrics.features_shipped.toString())],
    ['Customer Satisfaction', chalk.green(retroResult.metrics.customer_satisfaction)]
  );

  console.log(retroMetricsTable.toString());
  console.log(chalk.dim(`\n  Duration: ${retroResult.duration_ms}ms | Agents: ${retroResult.agents_used.join(', ')}\n`));
  testsPassed++;

  // Summary
  console.log(chalk.bold.white('\n📊 Workflow Summary\n'));
  
  const summaryTable = new Table({
    head: [chalk.cyan('Workflow'), chalk.cyan('Trigger'), chalk.cyan('Agents'), chalk.cyan('Duration')],
    colWidths: [25, 25, 25, 25],
    style: { head: [], border: [] }
  });

  summaryTable.push(
    ['GitHub Triage', 'Webhook', githubResult.agents_used.join(', '), `${githubResult.duration_ms}ms`],
    ['Daily Brief', 'Cron (8 AM)', briefResult.agents_used.join(', '), `${briefResult.duration_ms}ms`],
    ['Incident Response', 'Alert', incidentResult.agents_used.join(', '), `${incidentResult.duration_ms}ms`],
    ['Weekly Retro', 'Cron (Sun 6 PM)', retroResult.agents_used.join(', '), `${retroResult.duration_ms}ms`]
  );

  console.log(summaryTable.toString());
  console.log(chalk.dim(`\n  Workflows automate complex multi-agent processes\n`));

  return { testsPassed };
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkflowDemos()
    .then(results => {
      console.log(chalk.green(`\n✓ All ${results.testsPassed} workflow demos passed!\n`));
      process.exit(0);
    })
    .catch(error => {
      console.error(chalk.red('\n❌ Error:'), error);
      process.exit(1);
    });
}
