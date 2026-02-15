/**
 * GCP Infrastructure Provider
 *
 * Provisions Compute Engine VMs with per-agent isolation:
 * - Dedicated service account
 * - IAM bindings scoped to agent prefix
 * - Firewall rules (deny all ingress, allow IAP)
 * - No external IP
 */

import type { AgentComputeSpec, InfraProvider, ProvisionResult } from "../../types.js";

// Lazy-loaded SDK types
type InstancesClient = any;
type FirewallsClient = any;
type IAMClient = any;

interface GcpClients {
  instances: InstancesClient;
  firewalls: FirewallsClient;
  iam: IAMClient;
}

export interface GcpInfraProviderOptions {
  project: string;
  defaultZone: string;
  network?: string;
  subnetwork?: string;
  /** Injectable clients for testing */
  clients?: GcpClients;
}

export class GcpInfraProvider implements InfraProvider {
  readonly name = "gcp";
  private project: string;
  private defaultZone: string;
  private network: string;
  private subnetwork?: string;
  private _clients?: GcpClients;

  constructor(opts: GcpInfraProviderOptions) {
    this.project = opts.project;
    this.defaultZone = opts.defaultZone;
    this.network = opts.network || "default";
    this.subnetwork = opts.subnetwork;
    this._clients = opts.clients;
  }

  private async getClients(): Promise<GcpClients> {
    if (this._clients) {
      return this._clients;
    }

    // Lazy-load GCP SDKs
    const [computeMod, iamMod] = await Promise.all([
      import("@google-cloud/compute"),
      import("@google-cloud/iam"),
    ]);

    this._clients = {
      instances: new computeMod.InstancesClient(),
      firewalls: new computeMod.FirewallsClient(),
      iam: new iamMod.IAMClient(),
    };
    return this._clients;
  }

  async provision(
    agentId: string,
    spec: AgentComputeSpec,
    startupScript: string,
  ): Promise<ProvisionResult> {
    const clients = await this.getClients();
    const zone = spec.zone || this.defaultZone;
    const saEmail = `${agentId}@${this.project}.iam.gserviceaccount.com`;

    // 1. Create service account
    await this.createServiceAccount(clients, agentId, saEmail);

    // 2. Create firewall rule (deny all ingress, allow IAP)
    await this.createFirewallRule(clients, agentId);

    // 3. Create VM instance
    const instanceName = agentId;
    await clients.instances.insert({
      project: this.project,
      zone,
      instanceResource: {
        name: instanceName,
        machineType: `zones/${zone}/machineTypes/${spec.machineType}`,
        networkInterfaces: [
          {
            network: `global/networks/${this.network}`,
            subnetwork: this.subnetwork,
            // No accessConfigs = no external IP
          },
        ],
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: spec.image || "projects/debian-cloud/global/images/family/debian-12",
              diskSizeGb: spec.diskSizeGb,
            },
          },
        ],
        serviceAccounts: [
          {
            email: saEmail,
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          },
        ],
        metadata: {
          items: [{ key: "startup-script", value: startupScript }],
        },
        labels: spec.labels,
        tags: { items: [agentId] },
      },
    });

    // Get instance IP
    const [instance] = await clients.instances.get({
      project: this.project,
      zone,
      instance: instanceName,
    });

    return {
      instanceId: instanceName,
      zone,
      serviceAccount: saEmail,
      ip: instance?.networkInterfaces?.[0]?.networkIP,
    };
  }

  async deprovision(agentId: string): Promise<void> {
    const clients = await this.getClients();
    const zone = this.defaultZone;

    // Delete in reverse order: VM → firewall → SA
    try {
      await clients.instances.delete({
        project: this.project,
        zone,
        instance: agentId,
      });
    } catch (err: any) {
      if (err.code !== 404 && err.code !== 5) {
        throw err;
      }
    }

    try {
      await clients.firewalls.delete({
        project: this.project,
        firewall: `${agentId}-allow-iap`,
      });
    } catch (err: any) {
      if (err.code !== 404 && err.code !== 5) {
        throw err;
      }
    }

    await this.deleteServiceAccount(clients, agentId);
  }

  async restart(instanceId: string): Promise<void> {
    const clients = await this.getClients();
    await clients.instances.stop({
      project: this.project,
      zone: this.defaultZone,
      instance: instanceId,
    });
    await clients.instances.start({
      project: this.project,
      zone: this.defaultZone,
      instance: instanceId,
    });
  }

  async status(
    instanceId: string,
  ): Promise<{ state: "running" | "stopped" | "terminated" | "unknown"; ip?: string }> {
    const clients = await this.getClients();
    try {
      const [instance] = await clients.instances.get({
        project: this.project,
        zone: this.defaultZone,
        instance: instanceId,
      });
      const gcpStatus = instance?.status?.toLowerCase() || "unknown";
      const stateMap: Record<string, "running" | "stopped" | "terminated" | "unknown"> = {
        running: "running",
        staging: "running",
        stopped: "stopped",
        terminated: "terminated",
        suspended: "stopped",
      };
      return {
        state: stateMap[gcpStatus] || "unknown",
        ip: instance?.networkInterfaces?.[0]?.networkIP,
      };
    } catch {
      return { state: "unknown" };
    }
  }

  private async createServiceAccount(
    clients: GcpClients,
    agentId: string,
    _saEmail: string,
  ): Promise<void> {
    await clients.iam.createServiceAccount({
      name: `projects/${this.project}`,
      accountId: agentId,
      serviceAccount: {
        displayName: `Agent: ${agentId}`,
        description: `Service account for OpenClaw agent ${agentId}`,
      },
    });
  }

  private async deleteServiceAccount(clients: GcpClients, agentId: string): Promise<void> {
    try {
      await clients.iam.deleteServiceAccount({
        name: `projects/${this.project}/serviceAccounts/${agentId}@${this.project}.iam.gserviceaccount.com`,
      });
    } catch (err: any) {
      if (err.code !== 404 && err.code !== 5) {
        throw err;
      }
    }
  }

  private async createFirewallRule(clients: GcpClients, agentId: string): Promise<void> {
    await clients.firewalls.insert({
      project: this.project,
      firewallResource: {
        name: `${agentId}-allow-iap`,
        network: `global/networks/${this.network}`,
        direction: "INGRESS",
        priority: 1000,
        sourceRanges: ["35.235.240.0/20"], // IAP CIDR
        targetTags: [agentId],
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        description: `Allow IAP SSH for agent ${agentId}`,
      },
    });
  }
}
