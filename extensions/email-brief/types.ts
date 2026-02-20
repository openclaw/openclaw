/**
 * Shared types for the email-brief extension.
 */

/** Parsed result of `/email_brief [filters...] [period]` arguments. */
export type ParsedArgs = {
  /** Time period like "1d", "7d", "3h", "2w", "1m". Default: "1d". */
  period: string;
  /** Filter directives extracted from arguments. */
  filters: {
    from?: string;
    to?: string;
    urgent?: boolean;
    unread?: boolean;
    freeText?: string;
  };
};

/** An email message fetched from Gmail API with extracted content. */
export type EmailMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
};

/** Resolved Gmail configuration from env vars and plugin config. */
export type GmailConfig = {
  /** Parsed Service Account key JSON. */
  serviceAccountKey: ServiceAccountKey;
  /** Email address to impersonate via domain-wide delegation. */
  userEmail: string;
  /** Maximum emails to fetch (default: 20). */
  maxEmails: number;
};

/** Google Service Account JSON key structure (relevant fields only). */
export type ServiceAccountKey = {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  token_uri: string;
};
