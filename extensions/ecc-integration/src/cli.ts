import * as fs from "fs/promises";
import * as path from "path";
import { Command } from "commander";
import type { z } from "zod";
import type { AgentTypeSchema } from "./governance/engine.js";
import ECCIntegration from "./index.js";

const program = new Command();

// Initialize ECC Integration instance
let ecc: ECCIntegration;

async function getECC(): Promise<ECCIntegration> {
  if (!ecc) {
    ecc = new ECCIntegration();
    await ecc.initialize();
  }
  return ecc;
}

program
  .name("ecc-integration")
  .description("ECC (Everything Claude Code) Integration for OpenClaw")
  .version("1.0.0");

// ============================================================================
// Governance Commands
// ============================================================================

program
  .command("governance")
  .description("Manage governance rules and agents")
  .addCommand(
    new Command("status").description("Show governance system status").action(async () => {
      const system = await getECC();
      const systemStatus = system.getStatus();

      console.log("\n📋 Governance Status");
      console.log("===================");
      console.log(`Active Rules: ${systemStatus.governance.rulesActive}`);
      console.log(`Total Agents: ${systemStatus.governance.agents}`);
      console.log(`Total Tasks: ${systemStatus.governance.tasks}`);

      console.log("\n🤖 Agent Pools");
      console.log("==============");
      for (const [type, counts] of Object.entries(systemStatus.orchestration.agents)) {
        console.log(
          `${type}: ${counts.idle} idle / ${counts.working} working / ${counts.total} total`,
        );
      }

      console.log("\n📊 Task Queue");
      console.log("=============");
      console.log(`Total: ${systemStatus.orchestration.queue.total}`);
      for (const [queueStatus, count] of Object.entries(
        systemStatus.orchestration.queue.byStatus as Record<string, number>,
      )) {
        if (count > 0) console.log(`  ${queueStatus}: ${count}`);
      }
    }),
  )
  .addCommand(
    new Command("rules").description("List active governance rules").action(() => {
      console.log("\n⚖️  Core Governance Rules");
      console.log("========================");
      console.log("1. Rules > Freedom - All behavior governed by explicit rules");
      console.log("2. One Agent/One Task - Single responsibility per agent");
      console.log("3. Claude Code Integration - ECC knowledge for all operations");
      console.log("4. Security First - Mandatory security scanning");
      console.log("5. Continuous Learning - Instinct updates after tasks");
    }),
  );

// ============================================================================
// Agent Commands
// ============================================================================

program
  .command("agent")
  .description("Manage agents")
  .addCommand(
    new Command("create <type>")
      .description("Create a new agent of specified type")
      .action(async (type: string) => {
        const system = await getECC();
        const validTypes = ["architect", "developer", "reviewer", "security", "devops", "learning"];

        if (!validTypes.includes(type)) {
          console.error(`❌ Invalid agent type. Valid types: ${validTypes.join(", ")}`);
          process.exit(1);
        }

        const agent = await system.orchestrator.createAgent(
          type as z.infer<typeof AgentTypeSchema>,
        );
        console.log(`✅ Created ${type} agent: ${agent.id}`);
        console.log(`   Skills: ${agent.eccProfile.skills.join(", ")}`);
        console.log(`   Security Level: ${agent.eccProfile.securityLevel}`);
      }),
  )
  .addCommand(
    new Command("list").description("List all agents").action(async () => {
      const system = await getECC();
      const agents = system.governance.getAgents();

      console.log("\n🤖 Agents");
      console.log("=========");
      for (const agent of agents) {
        const task = agent.currentTask ? `working on "${agent.currentTask.title}"` : "idle";
        console.log(`${agent.id} (${agent.type}): ${agent.state} - ${task}`);
      }
    }),
  )
  .addCommand(
    new Command("instincts <agentId>")
      .description("Show instincts for an agent")
      .action(async (agentId: string) => {
        const system = await getECC();
        const instincts = system.learning.getInstincts(agentId);

        console.log(`\n🧠 Instincts for ${agentId}`);
        console.log("========================");

        if (instincts.length === 0) {
          console.log("No instincts learned yet.");
          return;
        }

        for (const instinct of instincts) {
          console.log(`\n${instinct.pattern}`);
          console.log(`  Confidence: ${(instinct.confidence * 100).toFixed(1)}%`);
          console.log(`  Source: ${instinct.source}`);
          console.log(`  Created: ${instinct.createdAt.toLocaleDateString()}`);
        }
      }),
  )
  .addCommand(
    new Command("skills <agentId>")
      .description("Show evolved skills for an agent")
      .action(async (agentId: string) => {
        const system = await getECC();
        const skills = system.learning.getSkills(agentId);

        console.log(`\n🎯 Skills for ${agentId}`);
        console.log("=====================");

        if (skills.length === 0) {
          console.log("No skills evolved yet.");
          return;
        }

        for (const skill of skills) {
          console.log(`\n${skill.name} (${skill.category})`);
          console.log(`  ${skill.description}`);
          console.log(`  Success Rate: ${(skill.successRate * 100).toFixed(1)}%`);
          console.log(`  Related Instincts: ${skill.relatedInstincts.length}`);
        }
      }),
  );

// ============================================================================
// Task Commands
// ============================================================================

program
  .command("task")
  .description("Manage tasks")
  .addCommand(
    new Command("submit <title>")
      .description("Submit a new task")
      .option("-d, --description <desc>", "Task description")
      .option("-p, --priority <level>", "Priority (low|medium|high|critical)", "medium")
      .option("-t, --type <agentType>", "Preferred agent type")
      .action(async (title: string, options) => {
        const system = await getECC();
        const taskId = await system.submitTask(title, options.description || title, {
          priority: options.priority,
          agentType: options.type,
        });

        console.log(`✅ Task submitted: ${taskId}`);
        console.log(`   Title: ${title}`);
        console.log(`   Priority: ${options.priority}`);
        if (options.type) console.log(`   Preferred Agent: ${options.type}`);
      }),
  )
  .addCommand(
    new Command("list").description("List all tasks").action(async () => {
      const system = await getECC();
      const tasks = system.governance.getTasks();

      console.log("\n📋 Tasks");
      console.log("========");

      for (const task of tasks) {
        const agent = task.agentId ? `(assigned to ${task.agentId})` : "(unassigned)";
        console.log(`${task.id}: [${task.priority}] ${task.title} - ${task.status} ${agent}`);
      }
    }),
  );

// ============================================================================
// Security Commands
// ============================================================================

program
  .command("security")
  .description("Security scanning and auditing")
  .addCommand(
    new Command("scan <path>")
      .description("Scan files for security issues")
      .action(async (scanPath: string) => {
        const system = await getECC();

        console.log(`🔍 Scanning ${scanPath}...`);

        try {
          const files = await getFilesToScan(scanPath);
          const result = await system.scanSecurity(files);

          console.log(result.report);

          if (!result.passed) {
            process.exit(1);
          }
        } catch (error) {
          console.error(`❌ Scan failed: ${error}`);
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("check <file>")
      .description("Check file against best practices")
      .action(async (filePath: string) => {
        const system = await getECC();

        try {
          const content = await fs.readFile(filePath, "utf-8");
          const result = system.checkPractices(filePath, content);

          console.log(`\n📊 Best Practice Check: ${filePath}`);
          console.log("================================");
          console.log(`Status: ${result.passed ? "✅ PASSED" : "❌ FAILED"}`);
          console.log(`Passed: ${result.passed_count}/${result.total}`);

          if (result.failed.length > 0) {
            console.log("\nIssues:");
            for (const issue of result.failed) {
              console.log(`\n  ${issue.name} (${issue.id})`);
              if (issue.message) console.log(`    ${issue.message}`);
              if (issue.suggestions) {
                console.log("    Suggestions:");
                for (const suggestion of issue.suggestions) {
                  console.log(`      - ${suggestion}`);
                }
              }
            }
          }
        } catch (error) {
          console.error(`❌ Check failed: ${error}`);
          process.exit(1);
        }
      }),
  );

// ============================================================================
// Learning Commands
// ============================================================================

program
  .command("learning")
  .description("Continuous learning and skill evolution")
  .addCommand(
    new Command("status").description("Show learning system status").action(async () => {
      const system = await getECC();
      const data = system.exportLearning();

      console.log("\n🧠 Learning System Status");
      console.log("=========================");
      console.log(`Total Instincts: ${data.summary.totalInstincts}`);
      console.log(`Total Skills: ${data.summary.totalSkills}`);
      console.log(`Average Confidence: ${(data.summary.avgConfidence * 100).toFixed(1)}%`);
    }),
  )
  .addCommand(
    new Command("export <file>")
      .description("Export learning data to file")
      .action(async (filePath: string) => {
        const system = await getECC();
        const data = system.exportLearning();

        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        console.log(`✅ Learning data exported to ${filePath}`);
      }),
  );

// ============================================================================
// Skill Commands
// ============================================================================

program
  .command("skill")
  .description("Skill creation and management")
  .addCommand(
    new Command("create <name>")
      .description("Create a skill from patterns")
      .option("-p, --patterns <patterns>", "Comma-separated patterns", "")
      .option("-o, --output <file>", "Output file for SKILL.md")
      .action(async (name: string, options) => {
        const system = await getECC();
        const patterns = options.patterns.split(",").filter((p: string) => p.trim());

        const result = system.generateSkill(name, patterns, []);

        if (options.output) {
          await fs.writeFile(options.output, result.markdown);
          console.log(`✅ Skill created: ${options.output}`);
        } else {
          console.log("\n" + result.markdown);
        }
      }),
  );

// ============================================================================
// Skill Audit & Import Commands
// ============================================================================

program
  .command("skill-audit")
  .description("Audit skills for security vulnerabilities")
  .addCommand(
    new Command("scan <path>")
      .description("Audit a skill or directory")
      .option("-q, --quick", "Quick screen only", false)
      .action(async (scanPath: string, options) => {
        const system = await getECC();

        if (options.quick) {
          console.log(`⚡ Quick screening: ${scanPath}`);
          const content = await fs.readFile(scanPath, "utf-8");
          const findings = await system.skillAuditor.quickScreen(content, scanPath);

          console.log(`\nFindings: ${findings.length}`);
          for (const f of findings) {
            console.log(`  [${f.severity.toUpperCase()}] ${f.title} at line ${f.line}`);
          }
        } else {
          console.log(`🔍 Auditing skill: ${scanPath}`);
          const result = await system.auditSkill(scanPath);

          console.log(`\n📊 Audit Results`);
          console.log(`================`);
          console.log(`Status: ${result.passed ? "✅ PASSED" : "❌ FAILED"}`);
          console.log(
            `Critical: ${result.criticalCount} | High: ${result.highCount} | Medium: ${result.mediumCount}`,
          );

          if (result.findings.length > 0) {
            console.log(`\nFindings:`);
            for (const f of result.findings) {
              console.log(`\n[${f.severity.toUpperCase()}] ${f.id}: ${f.title}`);
              console.log(`  Category: ${f.category}`);
              console.log(`  Location: ${f.file}:${f.line}`);
              console.log(`  ${f.description}`);
              if (f.remediation) {
                console.log(`  Fix: ${f.remediation}`);
              }
            }
          }
        }
      }),
  )
  .addCommand(
    new Command("import-github <url>")
      .description("Import skill from GitHub with mandatory audit")
      .option("--allow-medium", "Allow medium severity findings", false)
      .action(async (url: string, options) => {
        console.log(`🔽 Importing from: ${url}`);
        const system = await getECC();

        const result = await system.importSkillFromGitHub(url, {
          allowMedium: options.allowMedium,
        });

        if (result.success) {
          console.log(`✅ Successfully imported: ${result.skillName}`);
          console.log(`   Installed at: ${result.installPath}`);
        } else {
          console.error(`❌ Import failed: ${result.error}`);
          process.exit(1);
        }
      }),
  );

program
  .command("skills")
  .description("Skill collection management")
  .addCommand(
    new Command("browse").description("Browse available skill collections").action(async () => {
      const system = await getECC();
      await system.browseSkillCollections();
    }),
  )
  .addCommand(
    new Command("import-recommended")
      .description("Import all recommended skills with audits")
      .option("--allow-medium", "Allow medium severity findings", false)
      .action(async (options) => {
        console.log(`⭐ Importing recommended skills...`);
        const system = await getECC();

        const result = await system.importRecommendedSkills({
          allowMedium: options.allowMedium,
        });

        console.log(`\n📊 Import Summary`);
        console.log(`=================`);
        console.log(`Total: ${result.totalSkills}`);
        console.log(`✅ Imported: ${result.imported}`);
        console.log(`❌ Failed: ${result.failed}`);

        if (result.failed > 0) {
          console.log(`\nFailed imports:`);
          for (const r of result.results.filter((r) => !r.success)) {
            console.log(`  - ${r.skillName}: ${r.error}`);
          }
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("list").description("List installed skills with audit status").action(async () => {
      const system = await getECC();
      const skills = await system.listInstalledSkills();

      console.log(`\n📦 Installed Skills: ${skills.length}`);
      console.log(`================================`);
    }),
  )
  .addCommand(
    new Command("audit-report")
      .description("Generate comprehensive audit report")
      .option("-o, --output <file>", "Output file")
      .action(async (options) => {
        const system = await getECC();
        const report = await system.generateSkillAuditReport();

        if (options.output) {
          await fs.writeFile(options.output, report);
          console.log(`✅ Report saved: ${options.output}`);
        } else {
          console.log("\n" + report);
        }
      }),
  );

// ============================================================================
// Helper Functions
// ============================================================================

async function getFilesToScan(scanPath: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  const stat = await fs.stat(scanPath);

  if (stat.isFile()) {
    const content = await fs.readFile(scanPath, "utf-8");
    files.push({ path: scanPath, content });
  } else if (stat.isDirectory()) {
    const entries = await fs.readdir(scanPath, { recursive: true });

    for (const entry of entries) {
      const fullPath = path.join(scanPath, entry as string);
      const entryStat = await fs.stat(fullPath);

      if (entryStat.isFile() && shouldScanFile(fullPath)) {
        const content = await fs.readFile(fullPath, "utf-8");
        files.push({ path: fullPath, content });
      }
    }
  }

  return files;
}

function shouldScanFile(filePath: string): boolean {
  const scanExtensions = [".js", ".ts", ".jsx", ".tsx", ".json", ".yml", ".yaml"];
  const ext = path.extname(filePath);

  // Skip node_modules and hidden files
  if (filePath.includes("node_modules") || filePath.includes("/.")) {
    return false;
  }

  return scanExtensions.includes(ext);
}

// Run the CLI
program.parse();
