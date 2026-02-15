/**
 * Google Workspace Identity Provider
 *
 * Resolves users via Admin SDK, manages custom schema for agent config.
 * Uses domain-wide delegation for service account auth.
 */

import type { AgentConfig, IdentityProvider, UserEvent, UserIdentity } from "../../types.js";

interface GoogleAdminClient {
  users: {
    get: (params: { userKey: string }) => Promise<any>;
    list: (params: { domain: string; query?: string; customer?: string }) => Promise<any>;
    update: (params: { userKey: string; requestBody: any }) => Promise<any>;
  };
  schemas: {
    insert: (params: { customerId: string; requestBody: any }) => Promise<any>;
    update: (params: { customerId: string; schemaKey: string; requestBody: any }) => Promise<any>;
    get: (params: { customerId: string; schemaKey: string }) => Promise<any>;
  };
}

export interface GoogleWorkspaceProviderOptions {
  domain: string;
  adminEmail: string;
  credentialsPath?: string;
  /** Injectable client for testing */
  client?: GoogleAdminClient;
}

const SCHEMA_NAME = "OpenClaw_Agent";

export class GoogleWorkspaceIdentityProvider implements IdentityProvider {
  readonly name = "google-workspace";
  private domain: string;
  private adminEmail: string;
  private credentialsPath?: string;
  private _client?: GoogleAdminClient;

  constructor(opts: GoogleWorkspaceProviderOptions) {
    this.domain = opts.domain;
    this.adminEmail = opts.adminEmail;
    this.credentialsPath = opts.credentialsPath;
    this._client = opts.client;
  }

  private async getClient(): Promise<GoogleAdminClient> {
    if (this._client) {
      return this._client;
    }

    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: this.credentialsPath,
      scopes: [
        "https://www.googleapis.com/auth/admin.directory.user",
        "https://www.googleapis.com/auth/admin.directory.group.readonly",
        "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
        "https://www.googleapis.com/auth/admin.directory.userschema",
      ],
      clientOptions: { subject: this.adminEmail },
    });

    const admin = google.admin({ version: "directory_v1", auth });
    this._client = {
      users: {
        get: async (params) => {
          const res = await admin.users.get(params);
          return res.data;
        },
        list: async (params) => {
          const res = await admin.users.list(params);
          return res.data;
        },
        update: async (params) => {
          const res = await admin.users.update(params);
          return res.data;
        },
      },
      schemas: {
        insert: async (params) => {
          const res = await admin.schemas.insert(params);
          return res.data;
        },
        update: async (params) => {
          const res = await admin.schemas.update(params);
          return res.data;
        },
        get: async (params) => {
          const res = await admin.schemas.get(params);
          return res.data;
        },
      },
    };
    return this._client;
  }

  async resolveUser(email: string): Promise<UserIdentity | null> {
    const client = await this.getClient();
    try {
      const user = await client.users.get({ userKey: email });
      if (!user) {
        return null;
      }
      return this.mapUser(user);
    } catch (err: any) {
      if (err.code === 404 || err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async listUsers(filter?: { ou?: string; group?: string }): Promise<UserIdentity[]> {
    const client = await this.getClient();
    const params: any = { domain: this.domain };
    if (filter?.ou) {
      params.query = `orgUnitPath='${filter.ou}'`;
    }

    const result = await client.users.list(params);
    const users = result.users || [];
    return users.map((u: any) => this.mapUser(u));
  }

  async enableAgent(email: string, config: Partial<AgentConfig>): Promise<void> {
    const client = await this.getClient();
    await client.users.update({
      userKey: email,
      requestBody: {
        customSchemas: {
          [SCHEMA_NAME]: {
            agentEnabled: true,
            agentId: config.name || "",
            modelTier: config.modelTier || "sonnet",
            budgetCap: config.budgetCap?.toString() || "50",
            toolAllowlist: config.tools?.join(",") || "",
            channelRestrictions: config.channels?.join(",") || "",
            agentStatus: "provisioning",
          },
        },
      },
    });
  }

  async disableAgent(email: string): Promise<void> {
    const client = await this.getClient();
    await client.users.update({
      userKey: email,
      requestBody: {
        customSchemas: {
          [SCHEMA_NAME]: {
            agentEnabled: false,
            agentStatus: "disabled",
          },
        },
      },
    });
  }

  async ensureSchema(customerId: string): Promise<void> {
    const client = await this.getClient();
    const schemaBody = {
      schemaName: SCHEMA_NAME,
      fields: [
        { fieldName: "agentEnabled", fieldType: "BOOL" },
        { fieldName: "agentId", fieldType: "STRING" },
        { fieldName: "modelTier", fieldType: "STRING" },
        { fieldName: "budgetCap", fieldType: "STRING" },
        { fieldName: "toolAllowlist", fieldType: "STRING" },
        { fieldName: "channelRestrictions", fieldType: "STRING" },
        { fieldName: "agentStatus", fieldType: "STRING" },
        { fieldName: "lastHeartbeat", fieldType: "STRING" },
      ],
    };

    try {
      await client.schemas.get({ customerId, schemaKey: SCHEMA_NAME });
      await client.schemas.update({ customerId, schemaKey: SCHEMA_NAME, requestBody: schemaBody });
    } catch (err: any) {
      if (err.code === 404 || err.status === 404) {
        await client.schemas.insert({ customerId, requestBody: schemaBody });
      } else {
        throw err;
      }
    }
  }

  async onUserEvent(
    event: UserEvent,
  ): Promise<{ action: "provision" | "deprovision" | "reconfigure" | "none"; email: string }> {
    switch (event.type) {
      case "deleted":
      case "suspended":
        return { action: "deprovision", email: event.email };
      case "created": {
        const user = await this.resolveUser(event.email);
        if (user?.agentEnabled) {
          return { action: "provision", email: event.email };
        }
        return { action: "none", email: event.email };
      }
      case "updated":
      case "ou-changed":
        return { action: "reconfigure", email: event.email };
      default:
        return { action: "none", email: event.email };
    }
  }

  private mapUser(user: any): UserIdentity {
    const schema = user.customSchemas?.[SCHEMA_NAME];
    return {
      email: user.primaryEmail || user.email,
      displayName: user.name?.fullName || user.displayName || "",
      ou: user.orgUnitPath,
      agentEnabled: schema?.agentEnabled ?? false,
      agentConfig: schema
        ? {
            name: schema.agentId,
            modelTier: schema.modelTier,
            budgetCap: Number(schema.budgetCap) || 50,
            tools: schema.toolAllowlist?.split(",").filter(Boolean) || [],
            channels: schema.channelRestrictions?.split(",").filter(Boolean) || [],
          }
        : undefined,
    };
  }
}
