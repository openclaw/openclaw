type FeishuMediaAttachmentNameSource = {
  name?: string;
  path?: string;
  url?: string;
  mediaUrl?: string;
  filePath?: string;
};

/**
 * Resolve the explicit display filename for one outbound media item from a
 * reply payload's `attachments` metadata (aligned with `mediaUrls`; the
 * message tool's `filename` override lands in `attachments[].name`).
 * Returns undefined when no override was supplied, so callers keep the
 * loaded media's own filename (usually the local path basename).
 */
export function resolveFeishuMediaAttachmentFileName(params: {
  attachments?: readonly FeishuMediaAttachmentNameSource[];
  mediaUrl?: string;
  index?: number;
}): string | undefined {
  const attachments = params.attachments ?? [];
  const named = attachments
    .map((attachment, index) => ({ attachment, index, name: attachment.name?.trim() }))
    .filter((entry) => entry.name);
  if (named.length === 0) {
    return undefined;
  }
  if (params.index !== undefined) {
    const byIndex = named.find((entry) => entry.index === params.index);
    if (byIndex) {
      return byIndex.name;
    }
  }
  if (params.mediaUrl) {
    const bySource = named.find(({ attachment }) =>
      [attachment.path, attachment.url, attachment.mediaUrl, attachment.filePath].some(
        (source) => source?.trim() === params.mediaUrl,
      ),
    );
    if (bySource) {
      return bySource.name;
    }
  }
  // Feishu sends one media item per call, so a sole named attachment is the
  // override for that call even when its source reference was rewritten
  // (for example staged to a temp path) before reaching the adapter.
  return named.length === 1 && attachments.length === 1 ? named[0]!.name : undefined;
}
