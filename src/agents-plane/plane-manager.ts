/**
 * PlaneManager — Main orchestrator for the Agents Plane.
 *
 * Coordinates between infra, identity, and state providers
 * to manage agent lifecycle.
 */

import type {
  AgentConfig,
  AgentInstance,
  IdentityProvider,
  InfraProvider,
  PlaneConfig,
  PlaneState,
  StateStore,
} from "./types.js";

export class PlaneManager {
  constructor(
    private infra: InfraProvider,
    private identity: IdentityProvider,
    private state: StateStore,
  ) {}

  async createPlane(config: PlaneConfig): Promise<PlaneState> {
    const existing = await this.state.load(config.name);
    if (existing) {
      throw new Error(`Plane '${config.name}' already exists`);
    }

    const planeState: PlaneState = {
      config,
      agents: {},
      version: 0,
      updatedAt: new Date().toISOString(),
    };

    await this.state.save(planeState);
    return planeState;
  }

  async addAgent(planeId: string, agentConfig: AgentConfig): Promise<AgentInstance> {
    const unlock = await this.state.lock(planeId);
    try {
      const plane = await this.loadPlaneOrThrow(planeId);

      if (plane.agents[agentConfig.name]) {
        throw new Error(`Agent '${agentConfig.name}' already exists in plane '${planeId}'`);
      }

      // Validate owner exists
      const user = await this.identity.resolveUser(agentConfig.owner);
      if (!user) {
        throw new Error(`User '${agentConfig.owner}' not found in identity provider`);
      }

      const agentId = `${planeId}-${agentConfig.name}`;
      const machineType = agentConfig.machineType || plane.config.infra.defaults.machineType;
      const now = new Date().toISOString();

      // Build startup script
      const startupScript = this.renderStartupScript(agentId, agentConfig, plane.config);

      // Provision compute
      const result = await this.infra.provision(
        agentId,
        {
          machineType,
          region: plane.config.infra.region,
          diskSizeGb: plane.config.infra.defaults.diskSizeGb,
          image: plane.config.infra.defaults.image,
          labels: {
            plane: planeId,
            agent: agentConfig.name,
            owner: agentConfig.owner.replace("@", "-at-"),
          },
        },
        startupScript,
      );

      const instance: AgentInstance = {
        agentId,
        planeId,
        config: agentConfig,
        compute: {
          instanceId: result.instanceId,
          zone: result.zone,
          ip: result.ip,
        },
        iam: {
          serviceAccount: result.serviceAccount,
          iamUser: result.iamUser,
        },
        secrets: {
          prefix: `agents/${agentId}/`,
        },
        status: "provisioning",
        createdAt: now,
        updatedAt: now,
      };

      plane.agents[agentConfig.name] = instance;
      await this.state.save(plane);

      return instance;
    } finally {
      await unlock();
    }
  }

  async removeAgent(planeId: string, agentName: string): Promise<void> {
    const unlock = await this.state.lock(planeId);
    try {
      const plane = await this.loadPlaneOrThrow(planeId);
      const agent = plane.agents[agentName];
      if (!agent) {
        throw new Error(`Agent '${agentName}' not found in plane '${planeId}'`);
      }

      agent.status = "deprovisioning";
      await this.state.save(plane);

      await this.infra.deprovision(agent.agentId);

      delete plane.agents[agentName];
      await this.state.save(plane);
    } finally {
      await unlock();
    }
  }

  async getStatus(planeId: string): Promise<PlaneState> {
    return this.loadPlaneOrThrow(planeId);
  }

  async listAgents(planeId: string): Promise<AgentInstance[]> {
    const plane = await this.loadPlaneOrThrow(planeId);
    return Object.values(plane.agents);
  }

  async restartAgent(planeId: string, agentName: string): Promise<void> {
    const plane = await this.loadPlaneOrThrow(planeId);
    const agent = plane.agents[agentName];
    if (!agent) {
      throw new Error(`Agent '${agentName}' not found in plane '${planeId}'`);
    }
    await this.infra.restart(agent.compute.instanceId);
  }

  private async loadPlaneOrThrow(planeId: string): Promise<PlaneState> {
    const plane = await this.state.load(planeId);
    if (!plane) {
      throw new Error(`Plane '${planeId}' not found`);
    }
    return plane;
  }

  private renderStartupScript(
    agentId: string,
    agentConfig: AgentConfig,
    planeConfig: PlaneConfig,
  ): string {
    // Simple template rendering — no EJS dependency needed for now
    return `#!/bin/bash
set -euo pipefail

# Install OpenClaw
curl -fsSL https://openclaw.dev/install.sh | bash

# Configure agent
mkdir -p /home/agent/.openclaw
cat > /home/agent/.openclaw/config.json << 'AGENT_CONFIG'
{
  "agentId": "${agentId}",
  "owner": "${agentConfig.owner}",
  "modelTier": "${agentConfig.modelTier}",
  "model": "${agentConfig.model || ""}",
  "tools": ${JSON.stringify(agentConfig.tools)},
  "channels": ${JSON.stringify(agentConfig.channels)},
  "secrets": {
    "provider": "${planeConfig.secrets.provider}",
    "project": "${planeConfig.secrets.project || planeConfig.infra.project || ""}",
    "prefix": "agents/${agentId}/"
  }
}
AGENT_CONFIG

# Create agent user and start
useradd -m -s /bin/bash agent || true
chown -R agent:agent /home/agent/.openclaw
su - agent -c "openclaw gateway start"
`;
  }
}
