/**
 * Agent Delegation Demo
 * 
 * Demonstrates multi-agent collaboration and task delegation:
 * 1. Simple task delegation to specialized agents
 * 2. Multi-agent collaboration workflows
 * 3. Parallel agent execution
 * 4. Agent handoff patterns
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

// Mock Agent Delegation system
class AgentDelegator {
  private agents: Map<string, {
    id: string;
    name: string;
    capabilities: string[];
    system_prompt: string;
  }>;

  constructor() {
    this.agents = new Map();
    this.initializeAgents();
  }

  private initializeAgents() {
    const agents = [
      {
        id: 'PRIME',
        name: 'Prime Orchestrator',
        capabilities: ['coordination', 'routing', 'synthesis'],
        system_prompt: 'You are the master orchestrator. Coordinate other agents and synthesize results.'
      },
      {
        id: 'RESEARCH',
        name: 'Research Agent',
        capabilities: ['web_search', 'analysis', 'synthesis'],
        system_prompt: 'You are a research specialist. Find and analyze information.'
      },
      {
        id: 'CODE',
        name: 'Code Agent',
        capabilities: ['code_generation', 'code_review', 'testing'],
        system_prompt: 'You are a coding expert. Write and review code.'
      },
      {
        id: 'OPS',
        name: 'Operations Agent',
        capabilities: ['deployment', 'monitoring', 'incident_response'],
        system_prompt: 'You are an operations specialist. Manage infrastructure and incidents.'
      },
      {
        id: 'MEMORY',
        name: 'Memory Agent',
        capabilities: ['storage', 'retrieval', 'consolidation'],
        system_prompt: 'You manage memory and knowledge storage.'
      },
      {
        id: 'CRITIC',
        name: 'Critic Agent',
        capabilities: ['validation', 'security_review', 'quality_assurance'],
        system_prompt: 'You review and validate work for quality and security.'
      }
    ];

    agents.forEach(agent => this.agents.set(agent.id, agent));
  }

  async delegate(params: {
    task: string;
    context?: any;
    agent: string;
    timeout?: number;
  }) {
    const agentConfig = this.agents.get(params.agent);
    if (!agentConfig) {
      throw new Error(`Agent ${params.agent} not found`);
    }

    // Simulate agent execution
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    const duration = Date.now() - startTime;

    // Generate mock response based on agent type
    const responses: Record<string, string> = {
      PRIME: 'Task coordinated successfully. Results synthesized from multiple sources.',
      RESEARCH: 'Research completed. Found 3 relevant sources with high confidence.',
      CODE: 'Code implementation completed. All tests passing. Review suggested.',
      OPS: 'Operations task completed. Infrastructure updated successfully.',
      MEMORY: 'Memory stored and indexed. Retrieval optimized for future queries.',
      CRITIC: 'Review completed. No critical issues found. Minor suggestions provided.'
    };

    return {
      agent: params.agent,
      agent_name: agentConfig.name,
      output: responses[params.agent] || 'Task completed',
      duration_ms: duration,
      tokens_used: Math.floor(Math.random() * 2000) + 500,
      status: 'success'
    };
  }

  async createWorkflow(config: {
    name: string;
    steps: Array<{
      agent: string;
      task: string;
      input_keys?: string[];
      output_key: string;
    }>;
  }) {
    return {
      name: config.name,
      steps: config.steps,
      execute: async (context: any) => {
        const results: any[] = [];
        let currentContext = { ...context };

        for (const step of config.steps) {
          // Build task with context from previous steps
          let taskDescription = step.task;
          if (step.input_keys) {
            step.input_keys.forEach(key => {
              if (currentContext[key]) {
                taskDescription += `\n\nInput from ${key}: ${JSON.stringify(currentContext[key])}`;
              }
            });
          }

          // Execute step
          const result = await this.delegate({
            task: taskDescription,
            agent: step.agent,
            context: currentContext
          });

          // Store output in context
          currentContext[step.output_key] = result.output;
          
          results.push({
            step: step.agent,
            task: step.task,
            output: result.output,
            duration_ms: result.duration_ms,
            tokens_used: result.tokens_used
          });
        }

        return {
          workflow: config.name,
          steps: results,
          final_context: currentContext,
          total_duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
          total_tokens: results.reduce((sum, r) => sum + r.tokens_used, 0)
        };
      }
    };
  }

  getAgentStats() {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities
    }));
  }
}

// Demo runner
export async function runAgentDemos() {
  let testsPassed = 0;

  console.log(chalk.white('Initializing Agent Delegation System...\n'));
  const delegator = new AgentDelegator();
  const spinner = ora('Loading fleet agents').start();
  
  await new Promise(resolve => setTimeout(resolve, 500));
  spinner.succeed('Fleet agents loaded');

  // Display available agents
  console.log(chalk.bold.white('\n🤖 Available Fleet Agents:\n'));
  
  const agents = delegator.getAgentStats();
  const agentTable = new Table({
    head: [chalk.cyan('ID'), chalk.cyan('Name'), chalk.cyan('Capabilities')],
    colWidths: [12, 25, 63],
    style: { head: [], border: [] }
  });

  agents.forEach(agent => {
    agentTable.push([
      chalk.yellow(agent.id),
      agent.name,
      agent.capabilities.map(c => chalk.dim(c)).join(', ')
    ]);
  });

  console.log(agentTable.toString());

  // Demo 1: Simple Task Delegation
  console.log(chalk.bold.white('\n📋 Demo 1: Simple Task Delegation\n'));
  console.log(chalk.dim('Delegating error analysis to CODE agent...\n'));

  const simpleResult = await delegator.delegate({
    task: 'Analyze this error log and suggest fixes',
    context: {
      error_log: 'TypeError: Cannot read property "id" of undefined',
      file: 'src/users.ts',
      line: 42
    },
    agent: 'CODE',
    timeout: 30000
  });

  const simpleTable = new Table({
    head: [chalk.cyan('Field'), chalk.cyan('Value')],
    colWidths: [20, 80],
    style: { head: [], border: [] }
  });

  simpleTable.push(
    ['Agent', chalk.yellow(simpleResult.agent_name)],
    ['Output', simpleResult.output],
    ['Duration', `${simpleResult.duration_ms}ms`],
    ['Tokens', simpleResult.tokens_used.toString()],
    ['Status', chalk.green('✓ ' + simpleResult.status)]
  );

  console.log(simpleTable.toString());
  testsPassed++;

  // Demo 2: Multi-Agent Collaboration
  console.log(chalk.bold.white('\n🔄 Demo 2: Multi-Agent Collaboration\n'));
  console.log(chalk.dim('Creating feature development workflow...\n'));

  const workflow = delegator.createWorkflow({
    name: 'feature-development',
    steps: [
      {
        agent: 'PRIME',
        task: 'Analyze requirements for user authentication feature',
        output_key: 'requirements'
      },
      {
        agent: 'RESEARCH',
        task: 'Research best practices for JWT authentication',
        input_keys: ['requirements'],
        output_key: 'research'
      },
      {
        agent: 'CODE',
        task: 'Implement authentication module based on research',
        input_keys: ['requirements', 'research'],
        output_key: 'code'
      },
      {
        agent: 'CRITIC',
        task: 'Review code for security vulnerabilities',
        input_keys: ['code'],
        output_key: 'review'
      }
    ]
  });

  console.log(chalk.dim('Executing workflow with 4 agents in sequence...\n'));

  const workflowResult = await workflow.execute({
    project: 'my-app',
    feature: 'user-authentication'
  });

  const workflowTable = new Table({
    head: [
      chalk.cyan('Step'),
      chalk.cyan('Agent'),
      chalk.cyan('Duration'),
      chalk.cyan('Tokens'),
      chalk.cyan('Status')
    ],
    colWidths: [8, 20, 15, 12, 45],
    style: { head: [], border: [] }
  });

  workflowResult.steps.forEach((step, i) => {
    workflowTable.push([
      `#${i + 1}`,
      chalk.yellow(step.step),
      `${step.duration_ms}ms`,
      step.tokens_used.toString(),
      chalk.green('✓')
    ]);
  });

  console.log(workflowTable.toString());
  
  console.log(chalk.dim(`\n  Workflow: ${chalk.cyan(workflowResult.workflow)}`));
  console.log(chalk.dim(`  Total Duration: ${chalk.yellow(workflowResult.total_duration_ms)}ms`));
  console.log(chalk.dim(`  Total Tokens: ${chalk.cyan(workflowResult.total_tokens)}\n`));
  testsPassed++;

  // Demo 3: Parallel Agent Execution
  console.log(chalk.bold.white('\n⚡ Demo 3: Parallel Agent Execution\n'));
  console.log(chalk.dim('Executing 3 research tasks in parallel...\n'));

  const parallelStart = Date.now();
  const parallelResults = await Promise.all([
    delegator.delegate({
      task: 'Research React best practices for state management',
      agent: 'RESEARCH'
    }),
    delegator.delegate({
      task: 'Research Vue.js composition API patterns',
      agent: 'RESEARCH'
    }),
    delegator.delegate({
      task: 'Research Angular signals and reactive patterns',
      agent: 'RESEARCH'
    })
  ]);
  const parallelDuration = Date.now() - parallelStart;

  const parallelTable = new Table({
    head: [chalk.cyan('Task'), chalk.cyan('Duration'), chalk.cyan('Tokens')],
    colWidths: [60, 20, 20],
    style: { head: [], border: [] }
  });

  parallelResults.forEach((result, i) => {
    parallelTable.push([
      result.output.substring(0, 57) + '...',
      `${result.duration_ms}ms`,
      result.tokens_used.toString()
    ]);
  });

  console.log(parallelTable.toString());
  
  const sequentialDuration = parallelResults.reduce((sum, r) => sum + r.duration_ms, 0);
  console.log(chalk.dim(`\n  Parallel Execution: ${chalk.yellow(parallelDuration)}ms`));
  console.log(chalk.dim(`  Sequential Execution: ${chalk.dim(sequentialDuration)}ms`));
  console.log(chalk.dim(`  Speedup: ${chalk.green(((sequentialDuration / parallelDuration)).toFixed(2) + 'x')}\n`));
  testsPassed++;

  // Demo 4: Agent Handoff Pattern
  console.log(chalk.bold.white('\n🔁 Demo 4: Agent Handoff Pattern\n'));
  console.log(chalk.dim('Demonstrating PRIME → RESEARCH → CODE handoff...\n'));

  // Step 1: PRIME analyzes and routes
  const primeResult = await delegator.delegate({
    task: 'Analyze this task and determine which agent should handle it',
    context: { task: 'Implement a caching layer for API responses' },
    agent: 'PRIME'
  });

  console.log(chalk.dim(`  1. PRIME: ${primeResult.output}\n`));

  // Step 2: RESEARCH gathers information
  const researchResult = await delegator.delegate({
    task: 'Research caching strategies for API responses',
    agent: 'RESEARCH'
  });

  console.log(chalk.dim(`  2. RESEARCH: ${researchResult.output}\n`));

  // Step 3: CODE implements
  const codeResult = await delegator.delegate({
    task: 'Implement caching layer based on research findings',
    context: { research: researchResult.output },
    agent: 'CODE'
  });

  console.log(chalk.dim(`  3. CODE: ${codeResult.output}\n`));

  const handoffTable = new Table({
    head: [chalk.cyan('Agent'), chalk.cyan('Role'), chalk.cyan('Duration')],
    colWidths: [20, 50, 30],
    style: { head: [], border: [] }
  });

  handoffTable.push(
    [chalk.yellow('PRIME'), 'Analysis & Routing', `${primeResult.duration_ms}ms`],
    [chalk.yellow('RESEARCH'), 'Information Gathering', `${researchResult.duration_ms}ms`],
    [chalk.yellow('CODE'), 'Implementation', `${codeResult.duration_ms}ms`]
  );

  console.log(handoffTable.toString());
  console.log(chalk.dim(`\n  Agents collaborate through structured handoffs\n`));
  testsPassed++;

  // Demo 5: Agent Capabilities Matrix
  console.log(chalk.bold.white('\n📊 Demo 5: Agent Capabilities Matrix\n'));

  const capabilitiesTable = new Table({
    head: [
      chalk.cyan('Agent'),
      chalk.cyan('Coord'),
      chalk.cyan('Search'),
      chalk.cyan('Code'),
      chalk.cyan('Ops'),
      chalk.cyan('Memory'),
      chalk.cyan('Review')
    ],
    colWidths: [12, 12, 12, 12, 12, 12, 12],
    style: { head: [], border: [] }
  });

  const capabilitiesMap = {
    PRIME: ['coord', 'route', 'synth'],
    RESEARCH: ['search', 'analyze', 'synth'],
    CODE: ['code', 'test', 'review'],
    OPS: ['deploy', 'monitor', 'incident'],
    MEMORY: ['store', 'retrieve', 'consolidate'],
    CRITIC: ['validate', 'security', 'qa']
  };

  agents.forEach(agent => {
    const caps = capabilitiesMap[agent.id as keyof typeof capabilitiesMap] || [];
    capabilitiesTable.push([
      chalk.yellow(agent.id),
      caps.includes('coord') || caps.includes('route') ? chalk.green('✓') : chalk.dim('-'),
      caps.includes('search') ? chalk.green('✓') : chalk.dim('-'),
      caps.includes('code') ? chalk.green('✓') : chalk.dim('-'),
      caps.includes('deploy') ? chalk.green('✓') : chalk.dim('-'),
      caps.includes('store') ? chalk.green('✓') : chalk.dim('-'),
      caps.includes('review') || caps.includes('validate') ? chalk.green('✓') : chalk.dim('-')
    ]);
  });

  console.log(capabilitiesTable.toString());
  console.log(chalk.dim(`\n  Each agent specializes in specific capabilities\n`));
  testsPassed++;

  return { testsPassed };
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  runAgentDemos()
    .then(results => {
      console.log(chalk.green(`\n✓ All ${results.testsPassed} agent demos passed!\n`));
      process.exit(0);
    })
    .catch(error => {
      console.error(chalk.red('\n❌ Error:'), error);
      process.exit(1);
    });
}
