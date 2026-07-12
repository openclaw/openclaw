// Slack plugin module owns stable inbound delivery identities.
import { createHash } from "node:crypto";
import type { SlackMessageEvent } from "../types.js";

const SLACK_CONTENT_VERSION = Symbol("slackInboundContentVersion");

type SlackContentVersionMessage = SlackMessageEvent & {
  [SLACK_CONTENT_VERSION]?: string;
};

type SlackInboundContent = {
  files?: unknown;
  attachments?: unknown;
};

type SlackFileVersion = {
  identity: string;
  access: "direct" | "resolvable" | "missing";
};

type SlackAttachmentVersion = {
  identity: string;
  hasImage: boolean;
  files: SlackFileVersion[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareJson(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left) ?? "";
  const rightJson = JSON.stringify(right) ?? "";
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function projectSlackFiles(value: unknown): SlackFileVersion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      const file = asRecord(item);
      if (!file) {
        return null;
      }
      const id = stringField(file, "id");
      const hasDirectUrl = Boolean(
        stringField(file, "url_private_download") ?? stringField(file, "url_private"),
      );
      return {
        identity: id ? `id:${id}` : `index:${index}`,
        access: id ? "resolvable" : hasDirectUrl ? "direct" : "missing",
      } satisfies SlackFileVersion;
    })
    .filter((file): file is SlackFileVersion => file !== null)
    .toSorted(compareJson);
}

function projectSlackAttachments(value: unknown): SlackAttachmentVersion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      const attachment = asRecord(item);
      if (!attachment || attachment.is_share !== true) {
        return null;
      }
      const ts = stringField(attachment, "ts");
      const fallbackIdentity = [
        stringField(attachment, "channel_id"),
        stringField(attachment, "author_id"),
      ]
        .filter(Boolean)
        .join(":");
      return {
        identity: ts ? `ts:${ts}` : fallbackIdentity || `index:${index}`,
        hasImage: Boolean(stringField(attachment, "image_url")),
        files: projectSlackFiles(attachment.files),
      } satisfies SlackAttachmentVersion;
    })
    .filter((attachment): attachment is SlackAttachmentVersion => attachment !== null)
    .filter(
      (attachment) =>
        attachment.hasImage || attachment.files.some((file) => file.access !== "missing"),
    )
    .toSorted(compareJson);
}

function projectSlackInboundContent(content: SlackInboundContent) {
  return {
    attachments: projectSlackAttachments(content.attachments),
    files: projectSlackFiles(content.files),
  };
}

function collectSlackInboundDeliverableMediaIdentities(content: SlackInboundContent): Set<string> {
  const projection = projectSlackInboundContent(content);
  const identities = new Set<string>();
  for (const file of projection.files) {
    if (file.access !== "missing") {
      identities.add(`file:${file.identity}`);
    }
  }
  for (const attachment of projection.attachments) {
    if (attachment.hasImage) {
      identities.add(`attachment:${attachment.identity}:image`);
    }
    for (const file of attachment.files) {
      if (file.access !== "missing") {
        identities.add(`attachment:${attachment.identity}:file:${file.identity}`);
      }
    }
  }
  return identities;
}

export function hasNewSlackInboundDeliverableMedia(
  next: SlackInboundContent,
  previous: SlackInboundContent,
): boolean {
  const previousIdentities = collectSlackInboundDeliverableMediaIdentities(previous);
  for (const identity of collectSlackInboundDeliverableMediaIdentities(next)) {
    if (!previousIdentities.has(identity)) {
      return true;
    }
  }
  return false;
}

export function buildSlackInboundContentVersion(content: SlackInboundContent): string {
  // Mutable previews and URL values are intentionally excluded. An ID remains
  // one version while files.info hydrates Slack Connect access placeholders.
  const material = JSON.stringify(projectSlackInboundContent(content));
  return createHash("sha256").update(material).digest("base64url");
}

export function withSlackInboundContentVersion(
  message: SlackMessageEvent,
  version = buildSlackInboundContentVersion(message),
): SlackMessageEvent {
  return { ...message, [SLACK_CONTENT_VERSION]: version } as SlackContentVersionMessage;
}

export function resolveSlackInboundDeliveryId(message: SlackMessageEvent): string | undefined {
  if (!message.ts) {
    return undefined;
  }
  const version = (message as SlackContentVersionMessage)[SLACK_CONTENT_VERSION];
  return version ? `${message.ts}:content-v1:${version}` : message.ts;
}
