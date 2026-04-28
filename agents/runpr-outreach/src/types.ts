// Shared types for the RunPR outreach pipeline.

export type DetectedTool = "muckrack" | "cision" | "meltwater" | "multi" | "unknown";

export interface ContactedProspect {
  name: string;
  domain: string;
  contacted_at: string;
  source: string;
}

export interface ContactedFile {
  version: number;
  updated_at: string;
  prospects: ContactedProspect[];
}

export interface RawProspect {
  name: string;
  domain: string;
  url: string;
  blurb: string;
  source: string;
}

export interface DetectedToolResult {
  tool: DetectedTool;
  evidence: string[];
  confidence: "HIGH" | "MED" | "LOW";
}

export interface RecentNews {
  headline: string;
  url: string;
  published_at?: string;
  snippet: string;
}

export type ContactConfidence = "HIGH" | "MED" | "LOW";

export interface Contact {
  first_name: string;
  last_name: string;
  title: string;
  email: string;
  email_pattern: "first" | "first.last" | "firstinitiallast" | "info" | "unknown";
  confidence: ContactConfidence;
}

export interface DraftEmail {
  subject: string;
  body_text: string;
  body_html: string;
}

export interface ProspectRun {
  prospect: RawProspect;
  detected: DetectedToolResult;
  news: RecentNews | null;
  contact: Contact;
  draft: DraftEmail;
  gmail_draft_id?: string;
  gmail_draft_url?: string;
}

export interface RunOptions {
  dryRun: boolean;
  prospectsPerRun: number;
  exaApiKey: string;
  gmailAccount: string;
  notifyPhone: string;
}
