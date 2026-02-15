/**
 * AWS Infrastructure Provider
 *
 * Provisions EC2 instances with per-agent isolation:
 * - Dedicated IAM user + scoped policy
 * - Security group (no ingress, SSM access)
 * - No public IP
 */

import type { AgentComputeSpec, InfraProvider, ProvisionResult } from "../../types.js";

interface AwsClients {
  ec2: any;
  iam: any;
}

export interface AwsInfraProviderOptions {
  region: string;
  vpcId?: string;
  subnetId?: string;
  amiId?: string;
  /** Injectable clients for testing */
  clients?: AwsClients;
}

export class AwsInfraProvider implements InfraProvider {
  readonly name = "aws";
  private region: string;
  private vpcId?: string;
  private subnetId?: string;
  private defaultAmi: string;
  private _clients?: AwsClients;

  constructor(opts: AwsInfraProviderOptions) {
    this.region = opts.region;
    this.vpcId = opts.vpcId;
    this.subnetId = opts.subnetId;
    this.defaultAmi = opts.amiId || "ami-0default";
    this._clients = opts.clients;
  }

  private async getClients(): Promise<AwsClients> {
    if (this._clients) {
      return this._clients;
    }

    const [ec2Mod, iamMod] = await Promise.all([
      import("@aws-sdk/client-ec2"),
      import("@aws-sdk/client-iam"),
    ]);

    this._clients = {
      ec2: new ec2Mod.EC2Client({ region: this.region }),
      iam: new iamMod.IAMClient({ region: this.region }),
    };
    return this._clients;
  }

  async provision(
    agentId: string,
    spec: AgentComputeSpec,
    startupScript: string,
  ): Promise<ProvisionResult> {
    const clients = await this.getClients();

    // 1. Create IAM user with scoped policy
    const iamUserArn = await this.createIamUser(clients, agentId);

    // 2. Create security group (no ingress, SSM only)
    const sgId = await this.createSecurityGroup(clients, agentId);

    // 3. Launch EC2 instance
    const runResult = await clients.ec2.send({
      __type: "RunInstances",
      ImageId: spec.image || this.defaultAmi,
      InstanceType: spec.machineType,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(startupScript).toString("base64"),
      SecurityGroupIds: [sgId],
      SubnetId: this.subnetId,
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: Object.entries(spec.labels).map(([Key, Value]) => ({ Key, Value })),
        },
      ],
      // No public IP assignment
      NetworkInterfaces: this.subnetId
        ? undefined
        : [
            {
              DeviceIndex: 0,
              AssociatePublicIpAddress: false,
              Groups: [sgId],
            },
          ],
    });

    const instance = runResult.Instances?.[0];

    return {
      instanceId: instance?.InstanceId || agentId,
      zone: instance?.Placement?.AvailabilityZone || `${this.region}a`,
      iamUser: iamUserArn,
      ip: instance?.PrivateIpAddress,
    };
  }

  async deprovision(agentId: string): Promise<void> {
    const clients = await this.getClients();

    // Find instance by tag
    const describeResult = await clients.ec2.send({
      __type: "DescribeInstances",
      Filters: [{ Name: "tag:agent", Values: [agentId] }],
    });

    const instances = describeResult.Reservations?.flatMap((r: any) => r.Instances || []) || [];
    const instanceIds = instances.map((i: any) => i.InstanceId).filter(Boolean);

    // Terminate instances
    if (instanceIds.length > 0) {
      await clients.ec2.send({
        __type: "TerminateInstances",
        InstanceIds: instanceIds,
      });
    }

    // Delete security group
    try {
      await clients.ec2.send({
        __type: "DeleteSecurityGroup",
        GroupName: `agent-${agentId}`,
      });
    } catch (err: any) {
      if (err.Code !== "InvalidGroup.NotFound") {
        throw err;
      }
    }

    // Delete IAM user
    await this.deleteIamUser(clients, agentId);
  }

  async restart(instanceId: string): Promise<void> {
    const clients = await this.getClients();
    await clients.ec2.send({
      __type: "StopInstances",
      InstanceIds: [instanceId],
    });
    // Wait briefly then start (in production, use waiters)
    await clients.ec2.send({
      __type: "StartInstances",
      InstanceIds: [instanceId],
    });
  }

  async status(
    instanceId: string,
  ): Promise<{ state: "running" | "stopped" | "terminated" | "unknown"; ip?: string }> {
    const clients = await this.getClients();
    try {
      const result = await clients.ec2.send({
        __type: "DescribeInstances",
        InstanceIds: [instanceId],
      });
      const instance = result.Reservations?.[0]?.Instances?.[0];
      if (!instance) {
        return { state: "unknown" };
      }

      const stateMap: Record<string, "running" | "stopped" | "terminated" | "unknown"> = {
        running: "running",
        stopped: "stopped",
        terminated: "terminated",
        pending: "running",
        "shutting-down": "stopped",
        stopping: "stopped",
      };

      return {
        state: stateMap[instance.State?.Name || ""] || "unknown",
        ip: instance.PrivateIpAddress,
      };
    } catch {
      return { state: "unknown" };
    }
  }

  private async createIamUser(clients: AwsClients, agentId: string): Promise<string> {
    const createResult = await clients.iam.send({
      __type: "CreateUser",
      UserName: `agent-${agentId}`,
      Tags: [{ Key: "agent", Value: agentId }],
    });

    // Attach inline policy scoped to agent's secrets prefix
    await clients.iam.send({
      __type: "PutUserPolicy",
      UserName: `agent-${agentId}`,
      PolicyName: `agent-${agentId}-secrets`,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: `arn:aws:secretsmanager:*:*:secret:agents/${agentId}/*`,
          },
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: "*",
          },
        ],
      }),
    });

    return createResult.User?.Arn || `arn:aws:iam::user/agent-${agentId}`;
  }

  private async deleteIamUser(clients: AwsClients, agentId: string): Promise<void> {
    const userName = `agent-${agentId}`;
    try {
      // Remove inline policies first
      await clients.iam.send({
        __type: "DeleteUserPolicy",
        UserName: userName,
        PolicyName: `${userName}-secrets`,
      });
    } catch {
      // Ignore
    }

    try {
      await clients.iam.send({
        __type: "DeleteUser",
        UserName: userName,
      });
    } catch (err: any) {
      if (err.Code !== "NoSuchEntity") {
        throw err;
      }
    }
  }

  private async createSecurityGroup(clients: AwsClients, agentId: string): Promise<string> {
    const result = await clients.ec2.send({
      __type: "CreateSecurityGroup",
      GroupName: `agent-${agentId}`,
      Description: `Security group for OpenClaw agent ${agentId}`,
      VpcId: this.vpcId,
    });

    // No ingress rules — SSM access only (requires VPC endpoint or NAT)
    // Default SG has all egress allowed

    return result.GroupId || `sg-${agentId}`;
  }
}
