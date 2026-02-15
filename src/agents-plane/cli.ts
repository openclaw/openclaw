/**
 * Agents Plane CLI Commands
 *
 * Registered under `openclaw planes` subcommand.
 */

import type { Command } from "commander";
import type { PlaneConfig } from "./types.js";
import { PlaneManager } from "./plane-manager.js";
import { LocalStateStore } from "./state/store.js";

export function registerPlanesCommands(program: Command): void {
  const planes = program.command("planes").description("Manage agent planes");

  // ── openclaw planes create ──
  planes
    .command("create")
    .description("Create a new agent plane")
    .requiredOption("--name <name>", "Plane name")
    .requiredOption("--infra <provider>", "Infrastructure provider (gcp|aws)")
    .requiredOption("--identity <provider>", "Identity provider (google-workspace|entra)")
    .option("--region <region>", "Default region", "us-east4")
    .option("--domain <domain>", "Identity domain")
    .option("--project <project>", "Cloud project ID")
    .option("--state-dir <dir>", "Local state directory", ".openclaw/planes")
    .action(async (opts) => {
      const store = new LocalStateStore(opts.stateDir);
      const { infra, identity } = await resolveProviders(opts);
      const manager = new PlaneManager(infra, identity, store);

      const config: PlaneConfig = {
        name: opts.name,
        identity: { provider: opts.identity, domain: opts.domain || "" },
        infra: {
          provider: opts.infra,
          project: opts.project,
          region: opts.region,
          defaults: { machineType: "e2-small", diskSizeGb: 20 },
        },
        secrets: { provider: opts.infra === "gcp" ? "gcp-secret-manager" : "aws-secrets-manager" },
        network: { provider: opts.infra === "gcp" ? "iap" : "ssm" },
      };

      await manager.createPlane(config);
      console.log(`✅ Plane '${opts.name}' created. Add agents with: openclaw planes add-agent`);
    });

  // ── openclaw planes add-agent ──
  planes
    .command("add-agent")
    .description("Add an agent to a plane")
    .requiredOption("--plane <name>", "Plane name")
    .requiredOption("--user <email>", "Agent owner email")
    .option("--name <name>", "Agent name (default: derived from email)")
    .option("--model-tier <tier>", "Model tier (haiku|sonnet|opus)", "sonnet")
    .option("--budget <usd>", "Monthly budget cap", "50")
    .option("--machine-type <type>", "VM machine type")
    .option("--tools <tools>", "Comma-separated tool list", "email,calendar")
    .option("--channels <channels>", "Comma-separated channels", "email")
    .action(async (opts) => {
      const store = new LocalStateStore(opts.stateDir || ".openclaw/planes");
      const plane = await store.load(opts.plane);
      if (!plane) {
        console.error(`❌ Plane '${opts.plane}' not found`);
        process.exitCode = 1;
        return;
      }

      const { infra, identity } = await resolveProviders(plane.config);
      const manager = new PlaneManager(infra, identity, store);

      const agentName = opts.name || opts.user.split("@")[0] + "-agent";
      const agent = await manager.addAgent(opts.plane, {
        name: agentName,
        owner: opts.user,
        machineType: opts.machineType,
        modelTier: opts.modelTier,
        budgetCap: Number(opts.budget),
        tools: opts.tools.split(","),
        channels: opts.channels.split(","),
      });

      console.log(`✅ Agent '${agent.agentId}' provisioning for ${opts.user}...`);
      console.log(`   Instance: ${agent.compute.instanceId} (${agent.compute.zone})`);
    });

  // ── openclaw planes remove-agent ──
  planes
    .command("remove-agent")
    .description("Remove an agent from a plane")
    .requiredOption("--plane <name>", "Plane name")
    .requiredOption("--name <name>", "Agent name")
    .option("--force", "Skip confirmation")
    .action(async (opts) => {
      const store = new LocalStateStore(opts.stateDir || ".openclaw/planes");
      const plane = await store.load(opts.plane);
      if (!plane) {
        console.error(`❌ Plane '${opts.plane}' not found`);
        process.exitCode = 1;
        return;
      }

      const { infra, identity } = await resolveProviders(plane.config);
      const manager = new PlaneManager(infra, identity, store);
      await manager.removeAgent(opts.plane, opts.name);
      console.log(`✅ Agent '${opts.name}' removed from plane '${opts.plane}'`);
    });

  // ── openclaw planes status ──
  planes
    .command("status")
    .description("Show plane status")
    .option("--plane <name>", "Plane name")
    .action(async (opts) => {
      const store = new LocalStateStore(opts.stateDir || ".openclaw/planes");

      if (opts.plane) {
        const state = await store.load(opts.plane);
        if (!state) {
          console.error(`❌ Plane '${opts.plane}' not found`);
          process.exitCode = 1;
          return;
        }
        const agents = Object.values(state.agents);
        console.log(`Plane: ${state.config.name}`);
        console.log(`  Provider: ${state.config.infra.provider}`);
        console.log(`  Region: ${state.config.infra.region}`);
        console.log(`  Agents: ${agents.length}`);
        for (const a of agents) {
          console.log(`    ${a.agentId} — ${a.status} — ${a.config.owner}`);
        }
      } else {
        const planeIds = await store.list();
        if (planeIds.length === 0) {
          console.log("No planes found.");
          return;
        }
        for (const id of planeIds) {
          const state = await store.load(id);
          if (state) {
            const count = Object.keys(state.agents).length;
            console.log(
              `${id}: ${count} agent(s) — ${state.config.infra.provider}/${state.config.infra.region}`,
            );
          }
        }
      }
    });

  // ── openclaw planes list-agents ──
  planes
    .command("list-agents")
    .description("List agents in a plane")
    .requiredOption("--plane <name>", "Plane name")
    .action(async (opts) => {
      const store = new LocalStateStore(opts.stateDir || ".openclaw/planes");
      const plane = await store.load(opts.plane);
      if (!plane) {
        console.error(`❌ Plane '${opts.plane}' not found`);
        process.exitCode = 1;
        return;
      }

      const agents = Object.values(plane.agents);
      if (agents.length === 0) {
        console.log("No agents in plane.");
        return;
      }

      for (const a of agents) {
        console.log(
          `${a.agentId} | ${a.config.owner} | ${a.status} | ${a.config.modelTier} | $${a.config.budgetCap}/mo`,
        );
      }
    });
}

async function resolveProviders(config: any): Promise<{ infra: any; identity: any }> {
  let infra: any;
  let identity: any;

  if (config.infra?.provider === "gcp" || config.infra === "gcp") {
    const { GcpInfraProvider } = await import("./providers/infra/gcp.js");
    infra = new GcpInfraProvider({
      project: config.infra?.project || config.project || "",
      defaultZone: `${config.infra?.region || config.region || "us-east4"}-a`,
    });
  } else if (config.infra?.provider === "aws" || config.infra === "aws") {
    const { AwsInfraProvider } = await import("./providers/infra/aws.js");
    infra = new AwsInfraProvider({
      region: config.infra?.region || config.region || "us-east-1",
    });
  }

  if (config.identity?.provider === "google-workspace" || config.identity === "google-workspace") {
    const { GoogleWorkspaceIdentityProvider } =
      await import("./providers/identity/google-workspace.js");
    identity = new GoogleWorkspaceIdentityProvider({
      domain: config.identity?.domain || config.domain || "",
      adminEmail: config.identity?.adminEmail || "",
    });
  }

  return { infra, identity };
}
