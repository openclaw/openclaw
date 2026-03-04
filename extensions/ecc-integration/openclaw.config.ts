/**
 * OpenClaw + ECC Integration Configuration
 *
 * This file configures OpenClaw to use the ECC (Everything Claude Code)
 * integration with the three core governance rules:
 *
 * 1. Rules > Freedom - All agent behavior governed by explicit rules
 * 2. One Agent/One Task - Single responsibility per agent
 * 3. Claude Code Integration - ECC knowledge for all operations
 */

import eccPlugin from "./src/plugin.js";

export default {
  // Plugin registration
  plugins: [eccPlugin],

  // ECC Integration Settings
  ecc: {
    // Enable/disable features
    enabled: true,

    // Governance Rules (Your Three Core Rules)
    governance: {
      enabled: true,
      enforceSingleTaskPerAgent: true, // Rule #2
      requireRuleValidation: true, // Rule #1
      requireECCSkills: true, // Rule #3
      securityScanningRequired: true,
      continuousLearning: true,
    },

    // Agent Configuration
    agents: {
      // Auto-create default agent pool on startup
      autoInitialize: true,

      // Default agent types to create
      defaultTypes: ["architect", "developer", "reviewer", "security"],

      // Maximum agents per type
      maxAgentsPerType: 3,

      // Auto-scale when all agents busy
      autoScaling: true,

      // Task timeout (ms)
      taskTimeoutMs: 300000, // 5 minutes

      // Health check interval (ms)
      healthCheckIntervalMs: 30000, // 30 seconds
    },

    // Security Configuration
    security: {
      // Enable AgentShield-style scanning
      enabled: true,

      // Scan on code changes
      scanOnChange: true,

      // Block on critical findings
      blockOnCritical: true,

      // Security levels per agent type
      levels: {
        architect: "enhanced",
        developer: "enhanced",
        reviewer: "enhanced",
        security: "maximum",
        devops: "enhanced",
        learning: "standard",
      },
    },

    // Continuous Learning
    learning: {
      enabled: true,

      // Minimum confidence to create instinct
      minConfidenceThreshold: 0.7,

      // Maximum instincts per agent
      maxInstinctsPerAgent: 100,

      // Skill evolution interval (ms)
      skillEvolutionIntervalMs: 3600000, // 1 hour

      // Enable pattern recognition
      patternRecognitionEnabled: true,

      // Auto-export learning data
      autoExport: {
        enabled: true,
        intervalMs: 86400000, // 24 hours
        path: "./learning-data",
      },
    },

    // Best Practice Enforcement
    bestPractices: {
      enabled: true,

      // Enforce file size limits
      maxFileLines: 500,

      // Enforce TypeScript strict mode
      noExplicitAny: true,

      // Require documentation
      requireJSDoc: true,

      // Enforce error handling
      requireErrorHandling: true,
    },
  },

  // CLI Commands
  commands: {
    // Override default commands with ECC versions
    "agent-task": {
      description: "Create a governed agent task",
      plugin: "ecc-integration",
    },
    "agent-status": {
      description: "View ECC agent system status",
      plugin: "ecc-integration",
    },
    "security-scan": {
      description: "Run ECC security audit",
      plugin: "ecc-integration",
    },
    "skill-create": {
      description: "Generate ECC skills from patterns",
      plugin: "ecc-integration",
    },
    "instinct-status": {
      description: "View learned instincts",
      plugin: "ecc-integration",
    },
    governance: {
      description: "Manage governance rules",
      plugin: "ecc-integration",
      subcommands: ["status", "rules", "audit"],
    },
  },

  // System Integration
  system: {
    // WebSocket connection for real-time updates
    websocket: {
      enabled: true,
      port: 18789,
      host: "localhost",
    },

    // Logging
    logging: {
      level: "info",
      eccEvents: true,
      governanceDecisions: true,
      agentLifecycle: true,
    },

    // Metrics
    metrics: {
      enabled: true,
      agentPerformance: true,
      taskThroughput: true,
      learningProgress: true,
    },
  },
};
