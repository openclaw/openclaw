import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Contract = {
  id: number;
  state: string;
  intent: string;
  qa_doc: string | null;
  owner: string;
  project_id: string | null;
  claimed_by: string | null;
  system_ref: Record<string, unknown>;
  message_id: string | null;
  message_platform: string | null;
  message_account: string | null;
  sender_email: string | null;
  sender_name: string | null;
  attachment_ids: string[];
  attempt_count: number;
  max_attempts: number;
  qa_results: Record<string, unknown> | null;
  execution_log: string | null;
  reply_sent: boolean;
  reply_draft_id: string | null;
  reply_content: string | null;
  checkpoint1_msg_id: string | null;
  checkpoint2_msg_id: string | null;
  created_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

export type Contact = {
  id: number;
  email: string;
  name: string | null;
  communication_style: string | null;
  role_ids: string[];
  project_ids: string[];
};

export type Project = {
  id: string;
  name: string;
  vm_owner: string;
  chrome_profile: string;
  repo_path: string | null;
  domain: string | null;
};

export type Intent = {
  id: number;
  project_id: string;
  description: string;
  keywords: string[];
};

export type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export class Db {
  private pool: pg.Pool;

  constructor(config: DbConfig) {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 5,
    });
  }

  async migrate(): Promise<void> {
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // --- Contracts ---

  async createContract(data: {
    intent: string;
    qa_doc?: string;
    owner: string;
    project_id?: string;
    system_ref?: Record<string, unknown>;
    message_id?: string;
    message_platform?: string;
    message_account?: string;
    sender_email?: string;
    sender_name?: string;
    attachment_ids?: string[];
  }): Promise<Contract> {
    const res = await this.pool.query<Contract>(
      `INSERT INTO cos_contracts
        (intent, qa_doc, owner, project_id, system_ref, message_id, message_platform, message_account, sender_email, sender_name, attachment_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        data.intent,
        data.qa_doc ?? null,
        data.owner,
        data.project_id ?? null,
        JSON.stringify(data.system_ref ?? {}),
        data.message_id ?? null,
        data.message_platform ?? null,
        data.message_account ?? null,
        data.sender_email ?? null,
        data.sender_name ?? null,
        data.attachment_ids ?? [],
      ],
    );
    return res.rows[0];
  }

  async getContract(id: number): Promise<Contract | null> {
    const res = await this.pool.query<Contract>(
      "SELECT * FROM cos_contracts WHERE id = $1",
      [id],
    );
    return res.rows[0] ?? null;
  }

  async updateContract(
    id: number,
    updates: Partial<Pick<Contract,
      "state" | "claimed_by" | "qa_results" | "execution_log" |
      "attempt_count" | "reply_sent" | "reply_draft_id" | "reply_content" |
      "checkpoint1_msg_id" | "checkpoint2_msg_id" | "completed_at" | "claimed_at" |
      "message_account"
    >>,
  ): Promise<Contract | null> {
    const setClauses: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) continue;
      const dbVal = (key === "qa_results") ? JSON.stringify(val) : val;
      setClauses.push(`${key} = $${idx}`);
      values.push(dbVal);
      idx++;
    }

    values.push(id);
    const res = await this.pool.query<Contract>(
      `UPDATE cos_contracts SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return res.rows[0] ?? null;
  }

  async updateContractIntent(id: number, intent: string): Promise<void> {
    await this.pool.query(
      "UPDATE cos_contracts SET intent = $2, updated_at = NOW() WHERE id = $1",
      [id, intent],
    );
  }

  async claimContract(contractId: number, claimedBy: string): Promise<Contract | null> {
    const res = await this.pool.query<Contract>(
      `UPDATE cos_contracts
       SET claimed_by = $2, state = 'IMPLEMENTING', claimed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND state = 'PLANNING' AND claimed_by IS NULL
       RETURNING *`,
      [contractId, claimedBy],
    );
    return res.rows[0] ?? null;
  }

  async pollContracts(owner: string): Promise<Contract[]> {
    const res = await this.pool.query<Contract>(
      `SELECT * FROM cos_contracts
       WHERE owner = $1 AND state = 'PLANNING' AND claimed_by IS NULL
       ORDER BY created_at ASC`,
      [owner],
    );
    return res.rows;
  }

  async findRawContracts(): Promise<Contract[]> {
    const res = await this.pool.query<Contract>(
      "SELECT * FROM cos_contracts WHERE state = 'RAW' AND checkpoint1_msg_id IS NULL",
    );
    return res.rows;
  }

  async findCompletedContracts(): Promise<Contract[]> {
    const res = await this.pool.query<Contract>(
      "SELECT * FROM cos_contracts WHERE state = 'DONE' AND reply_sent = false",
    );
    return res.rows;
  }

  async contractExistsForMessage(messageId: string): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT 1 FROM cos_contracts WHERE message_id = $1 LIMIT 1",
      [messageId],
    );
    return res.rows.length > 0;
  }

  async findStuckContracts(): Promise<Contract[]> {
    const res = await this.pool.query<Contract>(
      "SELECT * FROM cos_contracts WHERE state = 'STUCK'",
    );
    return res.rows;
  }

  // --- Contacts ---

  async getContactByEmail(email: string): Promise<Contact | null> {
    const res = await this.pool.query<{
      id: number;
      email: string;
      name: string | null;
      communication_style: string | null;
      project_ids: string[] | null;
    }>(
      "SELECT id, email, name, communication_style, project_ids FROM contacts WHERE email = $1",
      [email.toLowerCase()],
    );
    const row = res.rows[0];
    if (!row) return null;

    const rolesRes = await this.pool.query<{ role_id: string }>(
      "SELECT role_id FROM contact_roles WHERE contact_id = $1",
      [row.id],
    );

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      communication_style: row.communication_style,
      role_ids: rolesRes.rows.map((r) => r.role_id),
      project_ids: row.project_ids ?? [],
    };
  }

  // --- Projects ---

  async getProject(id: string): Promise<Project | null> {
    const res = await this.pool.query<Project>(
      "SELECT * FROM cos_projects WHERE id = $1",
      [id],
    );
    return res.rows[0] ?? null;
  }

  async getProjectsByIds(ids: string[]): Promise<Project[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<Project>(
      "SELECT * FROM cos_projects WHERE id = ANY($1)",
      [ids],
    );
    return res.rows;
  }

  // --- Intents ---

  async getIntentsByProject(projectId: string): Promise<Intent[]> {
    const res = await this.pool.query<Intent>(
      "SELECT * FROM cos_intents WHERE project_id = $1",
      [projectId],
    );
    return res.rows;
  }

  // --- Admin queries ---

  async queryContracts(where: string, values: unknown[], limit: number): Promise<Contract[]> {
    const res = await this.pool.query<Contract>(
      `SELECT * FROM cos_contracts ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      values,
    );
    return res.rows;
  }

  // --- Stats ---

  async getContractCounts(): Promise<Record<string, number>> {
    const res = await this.pool.query<{ state: string; count: string }>(
      "SELECT state, COUNT(*)::text as count FROM cos_contracts GROUP BY state",
    );
    const counts: Record<string, number> = {};
    for (const row of res.rows) {
      counts[row.state] = parseInt(row.count, 10);
    }
    return counts;
  }
}
