#!/usr/bin/env -S node --import tsx
/**
 * Coperniq Data Snapshot Sync
 *
 * Paginates through the entire Coperniq API and writes flat JSON snapshots
 * to ~/.openclaw/cache/coperniq/ so that downstream consumers (JR, grading
 * pipeline) can read everything at once without pagination or N+1 queries.
 *
 * Usage (from repo root, deps installed):
 *   pnpm exec tsx scripts/coperniq-sync.ts            # full sync
 *   pnpm exec tsx scripts/coperniq-sync.ts --quick    # skip project details (phaseInstances)
 *   node --import tsx scripts/coperniq-sync.ts        # same if tsx is on NODE_PATH
 *
 * Requires: COPERNIQ_API_KEY in env or ~/.openclaw/.env
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const BASE_URL = "https://api.coperniq.io/v1";
const PAGE_SIZE = 100;
const CACHE_DIR = join(homedir(), ".openclaw", "cache", "coperniq");
const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
// TODO: implement exponential backoff for 429s
const REQUEST_DELAY_MS = 200;

// Files to auto-sync from repo → workspace on every run.
// IDENTITY.md and USER.md are intentionally excluded — JR manages those himself.
const WORKSPACE_SYNC_FILES = ["SOUL.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md"];

function syncWorkspaceFiles(): void {
  console.log("Syncing workspace files...");
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  for (const file of WORKSPACE_SYNC_FILES) {
    const src = join(REPO_ROOT, file);
    const dest = join(WORKSPACE_DIR, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      console.log(`  synced ${file}`);
    } else {
      console.log(`  skipped ${file} (not in repo)`);
    }
  }
}

function resolveApiKey(): string {
  if (process.env.COPERNIQ_API_KEY) {
    return process.env.COPERNIQ_API_KEY;
  }

  for (const envPath of [join(process.cwd(), ".env"), join(homedir(), ".openclaw", ".env")]) {
    try {
      const content = readFileSync(envPath, "utf-8");
      const match = content.match(/^COPERNIQ_API_KEY=(.+)$/m);
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // skip
    }
  }
  throw new Error("COPERNIQ_API_KEY not found in env or .env files");
}

const API_KEY = resolveApiKey();

async function apiFetch<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Coperniq API ${res.status}: ${url} — ${body}`);
  }
  return res.json() as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllPages<T>(endpoint: string): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const sep = endpoint.includes("?") ? "&" : "?";
    const url = `${endpoint}${sep}page_size=${PAGE_SIZE}&page=${page}`;
    const batch = await apiFetch<T[]>(url);
    if (!Array.isArray(batch)) {
      console.error(`  unexpected response on ${url}:`, batch);
      break;
    }
    all.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
    page++;
    await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

interface WorkOrder {
  id: number;
  title: string;
  status: string;
  isCompleted: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: { id: number; firstName: string; lastName: string; email: string } | null;
  collaborators: Array<{ id: number; firstName?: string; lastName?: string; email?: string }>;
  project: { id: number; uid: number; title: string } | null;
  checklist: Array<{ id: number; detail: string; isCompleted: boolean; completedAt?: string }>;
  statuses: Array<{ status: string; startedAt: string; endedAt: string; spentTime: number }>;
  [key: string]: unknown;
}

interface ProjectSummary {
  id: number;
  title: string;
  status: string;
  owner: { id: number; firstName: string; lastName: string; email: string } | null;
  salesRep: { id: number; firstName: string; lastName: string; email: string } | null;
  projectManager: { id: number; firstName: string; lastName: string; email: string } | null;
  phase: { name: string; status: string } | null;
  lastActivity: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface Comment {
  id: number;
  comment: string;
  createdAt: string;
  createdByUser: { id: number; firstName: string; lastName: string; email: string };
}

interface CommentsResponse {
  comments: Comment[];
  totalCount: number;
}

interface Note {
  id: number;
  note: string;
  createdAt: string;
  createdByUser: { id: number; firstName: string; lastName: string; email: string };
}

interface NotesResponse {
  notes: Note[];
  totalCount: number;
}

interface CoperniqRequest {
  id: number;
  title: string;
  description: string | null;
  address: string[];
  isActive: boolean;
  primaryEmail: string | null;
  primaryPhone: string | null;
  number: number;
  custom: Record<string, unknown>;
  trades: string[];
  value: number | null;
  size: number | null;
  confidence: number | null;
  workflowId: number | null;
  clientId: number | null;
  createdById: number;
  geoLocation: string[];
  imageUrl: string | null;
  streetViewUrl: string | null;
  city: string;
  zipcode: string;
  state: string;
  street: string;
  phase: { id: number; name: string; type: string } | null;
  phaseInstances: Array<{
    id: number;
    name: string;
    status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
    position: number;
    type: string;
    phaseTemplateId: number;
    phaseTemplate: {
      id: number;
      name: string;
      type: string;
      redSla?: number | null;
      yellowSla?: number | null;
    };
  }>;
  owner: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    avatarUrl?: string | null;
  } | null;
  salesRep: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    avatarUrl?: string | null;
  } | null;
  projectManager: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    avatarUrl?: string | null;
  } | null;
  jurisdiction: { id: number; name: string; uuid: string } | null;
  lastActivity: string | null;
  phaseId: number | null;
  workflowName: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface Account {
  id: number;
  title: string;
  description: string | null;
  address: string[];
  geoLocation: string[];
  imageUrl: string | null;
  streetViewUrl: string | null;
  isActive: boolean;
  primaryEmail: string | null;
  primaryPhone: string | null;
  city: string | null;
  zipcode: string | null;
  state: string | null;
  street: string | null;
  accountType: "RESIDENTIAL" | "COMMERCIAL" | null;
  clientType: "RESIDENTIAL" | "COMMERCIAL" | null;
  owner: { id: number; firstName: string; lastName: string; email: string } | null;
  lastActivity: string | null;
  number: number;
  createdBy: { id: number } | null;
  custom: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface CoperniqClient {
  id: number;
  title: string;
  description: string | null;
  address: string;
  isActive: boolean;
  primaryEmail: string | null;
  primaryPhone: string | null;
  number: number;
  custom: Record<string, unknown>;
  clientType: "RESIDENTIAL" | "COMMERCIAL" | null;
  contacts: Array<{ id: number; emails: string[]; phones: string[] }>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface CoperniqContact {
  id: number;
  companyId: number;
  name: string;
  phones: string[];
  emails: string[];
  title: string | null;
  createdAt: string;
  createdByUser: { id: number } | null;
  accounts: Array<{ id: number; title: string }>;
  clients: Array<{ id: number; title: string }>;
  projects: Array<{ id: number; title: string }>;
  [key: string]: unknown;
}

interface Invoice {
  id: number;
  uid: number;
  title: string;
  description: string | null;
  status: "DRAFT" | "SENT" | "DECLINED" | "PAID" | "PARTIALLY_PAID" | "OVERDUE" | null;
  basedOnId: number | null;
  basedOnUid: number | null;
  dueDate: string;
  amount: number;
  amountPaid: number;
  isArchived: boolean;
  sharedWithPortal: boolean;
  calculationMethod: string;
  percentage: number | null;
  baseAmount: number | null;
  createdAt: string;
  updatedAt: string;
  client: { id: number; title: string } | null;
  record: { id: number; uid: number; title: string } | null;
  lineItems: Array<{
    id: number;
    catalogItemId: number;
    quantity: number;
    unitCost: number;
    unitPrice: number;
    description: string | null;
    catalogItem: {
      id: number;
      name: string;
      manufacturer: string | null;
      sku: string | null;
      type: "PRODUCT" | "SERVICE";
    } | null;
  }>;
  [key: string]: unknown;
}

interface InvoiceListResponse {
  items: Invoice[];
  page: number;
  page_size: number;
  has_more: boolean;
}

interface Workflow {
  id: number;
  name: string;
  description: string | null;
  type: "PROJECT";
  createdAt: string;
  updatedAt: string;
  createdBy: { id: number; firstName: string; lastName: string; avatarUrl: string | null } | null;
  phases: Array<{
    id: number;
    name: string;
    type: string;
    description: string | null;
    redSla: number | null;
    yellowSla: number | null;
  }>;
}

interface Property {
  name: string;
  type: string;
  keyName: string;
  isMultiple: boolean;
  options: string[];
  defaultValue: unknown[];
}

interface PropertiesResponse {
  project: Property[];
  client: Property[];
  request: Property[];
}

interface CoperniqUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: { id: string; name: string };
}

interface Role {
  id: string;
  name: string;
  active: boolean;
}

interface Team {
  id: number;
  name: string;
  workers: Array<{
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    role: { id: string; name: string };
    isTeamLead?: boolean;
  }>;
}

interface Call {
  id: number;
  fromNumber: string;
  toNumber: string;
  isInbound: boolean;
  outcome: "ANSWERED" | "MISSED" | null;
  startTime: string | null;
  endTime: string | null;
  reason:
    | "PRODUCT"
    | "PROCESS"
    | "SERVICE"
    | "ACCOUNTING"
    | "REVENUE_OPPORTUNITY"
    | "FEEDBACK"
    | "OTHER"
    | null;
  disposition:
    | "INFO_PROVIDED"
    | "VISIT_SCHEDULED"
    | "ISSUE_RESOLVED"
    | "FOLLOW_UP"
    | "ESCALATION"
    | "NO_ACTION"
    | "UNRESPONSIVE"
    | "OTHER"
    | null;
  note: string | null;
  recordingUrl: string | null;
  transcriptUrl: string | null;
  missedCount: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CatalogItem {
  id: number;
  name: string;
  catalog: string;
  type: "PRODUCT" | "SERVICE";
  category: string | null;
  manufacturer: string | null;
  sku: string | null;
  code: string | null;
  cost: number;
  price: number;
  description: string | null;
  image: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  createdById: number;
  [key: string]: unknown;
}

interface ProjectForm {
  id: number;
  name: string;
  description: string | null;
  isCompleted: boolean;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: number;
  templateId: number;
  phaseId: number | null;
  phaseName: string | null;
  projectId: number;
  assignee: { id: number; firstName: string; lastName: string; email: string } | null;
  collaborators: Array<{ id: number; firstName: string; lastName: string }>;
  [key: string]: unknown;
}

interface ProjectFile {
  id: number;
  name: string;
  downloadUrl: string;
  type: string;
  source: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  companyId: number;
  createdByUser: { id: number; firstName: string; lastName: string } | null;
  metaData: {
    size: number;
    mimeType: string;
    extention: string;
    originalName: string;
    thumbnailUrl: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface LineItem {
  id: number;
  quantity: number;
  description: string;
  unitCost: number;
  totalCost: number;
  totalPrice: number;
  unitPrice: number;
  createdAt: string;
  catalogItem: {
    id: number;
    name: string;
    manufacturer: string | null;
    sku: string | null;
    type: "PRODUCT" | "SERVICE";
    description: string | null;
  };
}

interface ProjectDetail extends ProjectSummary {
  phaseInstances: Array<{
    id: number;
    name: string;
    status: string;
    position: number;
    startedAt?: string;
    completedAt?: string;
    phaseTemplate?: { id: number; name: string; redSla?: number; yellowSla?: number };
  }>;
}

function writeJson(filename: string, data: unknown): void {
  const path = join(CACHE_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  wrote ${path}`);
}

async function syncWorkOrders(): Promise<WorkOrder[]> {
  console.log("Syncing work orders...");
  const workOrders = await fetchAllPages<WorkOrder>("/work-orders");
  console.log(`  fetched ${workOrders.length} work orders`);
  writeJson("work-orders.json", workOrders);
  return workOrders;
}

async function syncProjects(): Promise<ProjectSummary[]> {
  console.log("Syncing projects...");
  const projects = await fetchAllPages<ProjectSummary>("/projects");
  console.log(`  fetched ${projects.length} projects`);
  writeJson("projects.json", projects);
  return projects;
}

async function syncAccounts(): Promise<Account[]> {
  console.log("Syncing accounts...");
  const accounts = await fetchAllPages<Account>("/accounts");
  console.log(`  fetched ${accounts.length} accounts`);
  writeJson("accounts.json", accounts);
  return accounts;
}

async function syncRequests(): Promise<CoperniqRequest[]> {
  console.log("Syncing requests...");
  const requests = await fetchAllPages<CoperniqRequest>("/requests");
  console.log(`  fetched ${requests.length} requests`);
  writeJson("requests.json", requests);
  return requests;
}

async function syncClients(): Promise<CoperniqClient[]> {
  console.log("Syncing clients...");
  const clients = await fetchAllPages<CoperniqClient>("/clients?include_contacts=true");
  console.log(`  fetched ${clients.length} clients`);
  writeJson("clients.json", clients);
  return clients;
}

async function syncContacts(): Promise<CoperniqContact[]> {
  console.log("Syncing contacts...");
  const contacts = await fetchAllPages<CoperniqContact>("/contacts");
  console.log(`  fetched ${contacts.length} contacts`);
  writeJson("contacts.json", contacts);
  return contacts;
}

async function syncProjectDetails(projects: ProjectSummary[]): Promise<void> {
  console.log(`Syncing project details (phaseInstances) for ${projects.length} projects...`);
  const details: ProjectDetail[] = [];
  for (const p of projects) {
    try {
      const detail = await apiFetch<ProjectDetail>(`/projects/${p.id}`);
      details.push(detail);
    } catch (err) {
      console.error(`  failed to fetch project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  fetched ${details.length} project details`);
  writeJson("project-details.json", details);
}

async function syncInvoices(): Promise<Invoice[]> {
  console.log("Syncing invoices...");
  const all: Invoice[] = [];
  let page = 1;
  while (true) {
    const res = await apiFetch<InvoiceListResponse>(
      `/invoices?page_size=${PAGE_SIZE}&page=${page}`,
    );
    all.push(...(res.items ?? []));
    if (!res.has_more) {
      break;
    }
    page++;
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  fetched ${all.length} invoices`);
  writeJson("invoices.json", all);
  return all;
}

async function syncWorkflows(): Promise<void> {
  console.log("Syncing workflows...");
  const workflows = await fetchAllPages<Workflow>("/workflows");
  console.log(`  fetched ${workflows.length} workflows`);
  writeJson("workflows.json", workflows);
}

async function syncProperties(): Promise<void> {
  console.log("Syncing properties...");
  const props = await apiFetch<PropertiesResponse>("/properties");
  const total =
    (props.project?.length ?? 0) + (props.client?.length ?? 0) + (props.request?.length ?? 0);
  console.log(
    `  fetched ${total} properties (project: ${props.project?.length ?? 0}, client: ${props.client?.length ?? 0}, request: ${props.request?.length ?? 0})`,
  );
  writeJson("properties.json", props);
}

async function syncUsers(): Promise<CoperniqUser[]> {
  console.log("Syncing users...");
  const users = await apiFetch<CoperniqUser[]>("/users");
  console.log(`  fetched ${users.length} users`);
  writeJson("users.json", users);
  return users;
}

async function syncRoles(): Promise<Role[]> {
  console.log("Syncing roles...");
  const roles = await apiFetch<Role[]>("/roles");
  console.log(`  fetched ${roles.length} roles`);
  writeJson("roles.json", roles);
  return roles;
}

async function syncTeams(): Promise<Team[]> {
  console.log("Syncing teams...");
  const teams = await apiFetch<Team[]>("/teams");
  console.log(`  fetched ${teams.length} teams`);
  writeJson("teams.json", teams);
  return teams;
}

async function syncCalls(projects: ProjectSummary[]): Promise<void> {
  console.log(`Syncing calls for ${projects.length} projects...`);
  const allCalls: Array<Call & { projectId: number; projectTitle: string }> = [];
  for (const p of projects) {
    try {
      const calls = await apiFetch<Call[]>(`/projects/${p.id}/calls`);
      for (const c of calls ?? []) {
        allCalls.push({ ...c, projectId: p.id, projectTitle: p.title });
      }
    } catch (err) {
      console.error(`  failed to fetch calls for project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  fetched ${allCalls.length} calls across ${projects.length} projects`);
  writeJson("calls.json", allCalls);
}

async function syncLineItems(projects: ProjectSummary[]): Promise<void> {
  console.log(`Syncing line items for ${projects.length} projects...`);
  const allLineItems: Array<LineItem & { projectId: number; projectTitle: string }> = [];
  for (const p of projects) {
    try {
      const items = await apiFetch<LineItem[]>(`/projects/${p.id}/line-items`);
      for (const item of items ?? []) {
        allLineItems.push({ ...item, projectId: p.id, projectTitle: p.title });
      }
    } catch (err) {
      console.error(`  failed to fetch line items for project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  fetched ${allLineItems.length} line items across ${projects.length} projects`);
  writeJson("line-items.json", allLineItems);
}

async function syncCatalogItems(): Promise<void> {
  console.log("Syncing catalog items...");
  // This endpoint returns all items in one shot and ignores pagination params
  const items = await apiFetch<CatalogItem[]>("/catalog-items");
  const active = (items ?? []).filter((i) => !i.isArchived);
  console.log(`  fetched ${active.length} active catalog items (${items.length} total)`);
  writeJson("catalog-items.json", active);
}

async function syncProjectForms(projects: ProjectSummary[]): Promise<void> {
  console.log(`Syncing forms for ${projects.length} projects...`);
  const allForms: Array<ProjectForm & { projectTitle: string }> = [];
  let projectsWithForms = 0;

  for (const p of projects) {
    try {
      const forms = await apiFetch<ProjectForm[]>(`/projects/${p.id}/forms`);
      if ((forms ?? []).length > 0) {
        projectsWithForms++;
        for (const f of forms) {
          allForms.push({ ...f, projectTitle: p.title });
        }
      }
    } catch (err) {
      console.error(`  failed to fetch forms for project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  fetched ${allForms.length} forms across ${projectsWithForms} projects`);
  writeJson("project-forms.json", allForms);
}

async function syncProjectFiles(projects: ProjectSummary[]): Promise<void> {
  console.log(`Syncing files for ${projects.length} projects...`);
  const allFiles: Array<ProjectFile & { projectId: number; projectTitle: string }> = [];
  let projectsWithFiles = 0;

  for (const p of projects) {
    try {
      const files = await apiFetch<ProjectFile[]>(`/projects/${p.id}/files`);
      const active = (files ?? []).filter((f) => !f.isArchived);
      if (active.length > 0) {
        projectsWithFiles++;
        for (const f of active) {
          allFiles.push({ ...f, projectId: p.id, projectTitle: p.title });
        }
      }
    } catch (err) {
      console.error(`  failed to fetch files for project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  fetched ${allFiles.length} files across ${projectsWithFiles} projects`);
  writeJson("project-files.json", allFiles);
}

async function syncComments(projects: ProjectSummary[]): Promise<void> {
  console.log(`Syncing comments for ${projects.length} projects...`);
  const allComments: Array<Comment & { projectId: number; projectTitle: string }> = [];
  let projectsWithComments = 0;

  for (const p of projects) {
    try {
      const data = await apiFetch<CommentsResponse>(
        `/projects/${p.id}/comments?page_size=${PAGE_SIZE}`,
      );
      const comments = data.comments ?? [];
      if (comments.length > 0) {
        projectsWithComments++;
        for (const c of comments) {
          allComments.push({ ...c, projectId: p.id, projectTitle: p.title });
        }
        // If there are more comments than one page, paginate
        if (data.totalCount > PAGE_SIZE) {
          let page = 2;
          let fetched = comments.length;
          while (fetched < data.totalCount) {
            await sleep(REQUEST_DELAY_MS);
            const next = await apiFetch<CommentsResponse>(
              `/projects/${p.id}/comments?page_size=${PAGE_SIZE}&page=${page}`,
            );
            for (const c of next.comments ?? []) {
              allComments.push({ ...c, projectId: p.id, projectTitle: p.title });
            }
            fetched += (next.comments ?? []).length;
            page++;
          }
        }
      }
    } catch (err) {
      console.error(`  failed to fetch comments for project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  fetched ${allComments.length} comments across ${projectsWithComments} projects`);
  writeJson("comments.json", allComments);
}

async function syncNotes(
  projects: ProjectSummary[],
): Promise<Array<Note & { projectId: number; projectTitle: string }>> {
  console.log(`Syncing notes for ${projects.length} projects...`);
  const allNotes: Array<Note & { projectId: number; projectTitle: string }> = [];
  let projectsWithNotes = 0;

  for (const p of projects) {
    try {
      const data = await apiFetch<NotesResponse>(`/projects/${p.id}/notes`);
      const notes = data.notes ?? [];
      if (notes.length > 0) {
        projectsWithNotes++;
        for (const n of notes) {
          allNotes.push({ ...n, projectId: p.id, projectTitle: p.title });
        }
      }
    } catch (err) {
      console.error(`  failed to fetch notes for project ${p.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  fetched ${allNotes.length} notes across ${projectsWithNotes} projects`);
  writeJson("notes.json", allNotes);
  return allNotes;
}

async function syncAccountNotes(
  accounts: Account[],
): Promise<Array<Note & { accountId: number; accountTitle: string }>> {
  console.log(`Syncing notes for ${accounts.length} accounts...`);
  const allNotes: Array<Note & { accountId: number; accountTitle: string }> = [];
  let accountsWithNotes = 0;

  for (const a of accounts) {
    try {
      const data = await apiFetch<NotesResponse>(`/accounts/${a.id}/notes`);
      const notes = data.notes ?? [];
      if (notes.length > 0) {
        accountsWithNotes++;
        for (const n of notes) {
          allNotes.push({ ...n, accountId: a.id, accountTitle: a.title });
        }
      }
    } catch (err) {
      console.error(`  failed to fetch notes for account ${a.id}: ${String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  fetched ${allNotes.length} notes across ${accountsWithNotes} accounts`);
  writeJson("account-notes.json", allNotes);
  return allNotes;
}

function buildEmployeeSummary(
  workOrders: WorkOrder[],
  projects: ProjectSummary[],
  comments: Array<Comment & { projectId: number; projectTitle: string }>,
  notes: Array<Note & { projectId: number; projectTitle: string }>,
): void {
  console.log("Building employee summary...");

  const employees = new Map<
    number,
    {
      id: number;
      name: string;
      email: string;
      workOrders: {
        total: number;
        completed: number;
        working: number;
        waiting: number;
        assigned: number;
      };
      projects: { asOwner: number; asSalesRep: number; asProjectManager: number };
      comments: { total: number; today: number };
      notes: { total: number; today: number };
    }
  >();

  function ensureEmployee(user: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
  }) {
    if (!employees.has(user.id)) {
      employees.set(user.id, {
        id: user.id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        workOrders: { total: 0, completed: 0, working: 0, waiting: 0, assigned: 0 },
        projects: { asOwner: 0, asSalesRep: 0, asProjectManager: 0 },
        comments: { total: 0, today: 0 },
        notes: { total: 0, today: 0 },
      });
    }
    return employees.get(user.id)!;
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  for (const wo of workOrders) {
    if (!wo.assignee) {
      continue;
    }

    // Filter out work orders if the parent project is ON_HOLD or CANCELLED (per Ridge's policy)
    if (wo.project) {
      const parentProject = projects.find((p) => p.id === wo.project.id);
      if (
        parentProject &&
        (parentProject.status === "ON_HOLD" || parentProject.status === "CANCELLED")
      ) {
        continue;
      }
    }

    const emp = ensureEmployee(wo.assignee);
    emp.workOrders.total++;
    if (wo.isCompleted) {
      emp.workOrders.completed++;
    }
    const statusLower = (wo.status ?? "").toLowerCase();
    if (statusLower === "working") {
      emp.workOrders.working++;
    } else if (statusLower === "waiting") {
      emp.workOrders.waiting++;
    } else if (statusLower === "assigned") {
      emp.workOrders.assigned++;
    }
  }

  for (const p of projects) {
    if (p.owner) {
      ensureEmployee(p.owner).projects.asOwner++;
    }
    if (p.salesRep) {
      ensureEmployee(p.salesRep).projects.asSalesRep++;
    }
    if (p.projectManager) {
      ensureEmployee(p.projectManager).projects.asProjectManager++;
    }
  }

  for (const c of comments) {
    if (!c.createdByUser) {
      continue;
    }
    const emp = ensureEmployee(c.createdByUser);
    emp.comments.total++;
    if (c.createdAt?.includes(todayStr)) {
      emp.comments.today++;
    }
  }

  for (const n of notes) {
    if (!n.createdByUser) {
      continue;
    }
    const emp = ensureEmployee(n.createdByUser);
    emp.notes.total++;
    if (n.createdAt?.includes(todayStr)) {
      emp.notes.today++;
    }
  }

  const summary = Array.from(employees.values()).toSorted((a, b) => a.name.localeCompare(b.name));
  writeJson("employee-summary.json", summary);
  console.log(`  built summary for ${summary.length} employees`);
}

async function main() {
  const quick = process.argv.includes("--quick");
  const startMs = Date.now();

  console.log(`Coperniq Sync — ${new Date().toISOString()}`);
  console.log(`Cache dir: ${CACHE_DIR}`);
  mkdirSync(CACHE_DIR, { recursive: true });

  syncWorkspaceFiles();

  const workOrders = await syncWorkOrders();
  const projects = await syncProjects();
  const accounts = await syncAccounts();
  const requests = await syncRequests();
  const clients = await syncClients();
  const contacts = await syncContacts();
  const invoices = await syncInvoices();
  const users = await syncUsers();
  await syncRoles();
  await syncTeams();
  await syncProperties();
  await syncWorkflows();

  await syncProjectDetails(projects);

  if (!quick) {
    await syncLineItems(projects);
    await syncCalls(projects);
  }

  await syncCatalogItems();
  await syncProjectForms(projects);
  await syncProjectFiles(projects);
  await syncComments(projects);
  const notesData = await syncNotes(projects);
  const accountNotesData = await syncAccountNotes(accounts);

  // Read back comments for summary
  const commentsRaw = JSON.parse(readFileSync(join(CACHE_DIR, "comments.json"), "utf-8"));
  buildEmployeeSummary(workOrders, projects, commentsRaw, notesData);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  const meta = {
    lastSyncAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    counts: {
      workOrders: workOrders.length,
      projects: projects.length,
      accounts: accounts.length,
      requests: requests.length,
      clients: clients.length,
      contacts: contacts.length,
      invoices: invoices.length,
      users: users.length,
      comments: commentsRaw.length,
      notes: notesData.length,
      accountNotes: accountNotesData.length,
    },
    quick,
  };
  writeJson("meta.json", meta);

  console.log(`\nDone in ${elapsed}s`);
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error("Coperniq sync failed:", err);
  process.exit(1);
});
