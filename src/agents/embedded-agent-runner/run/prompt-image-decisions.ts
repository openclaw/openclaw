import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { ImageContent, UserMessage } from "../../../llm/types.js";
import { isImageMediaFact, type MediaFact } from "../../../media/media-facts.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";

type ImageResolution = {
  images: ImageContent[];
  imageFactIndexes: (number | null)[];
  failedMediaCount: number;
};
type ImageDecision = {
  media: Map<number, MediaFact>;
  /** Hashes of the sanitized images the model received, per media part. */
  hashes: Map<number | null, Set<string>>;
  includedCount: number;
  failedMediaCount: number;
};

// Only identities and hashes survive a request, never image bytes. Restarting the
// Gateway or LRU eviction recomputes decisions once; disappearing sources can still miss cache.
const MAX_IMAGE_DECISION_SESSIONS = 1_000;
const sessions = new Map<string, Map<string, ImageDecision>>();

export function promptImageSessionKey(params: {
  sessionId: string;
  agentId?: string;
  sessionTarget?: AgentRunSessionTarget;
  workspaceDir: string;
}): string {
  return JSON.stringify([
    params.sessionTarget?.storePath,
    params.sessionTarget?.agentId ?? params.agentId,
    params.sessionId,
    params.workspaceDir,
  ]);
}

function imageHash(image: ImageContent): string {
  return sha256Hex(`${image.mimeType}\0${image.data}`);
}

/** Pin inclusion per session, user identity, and media part without transcript writes. */
export async function resolvePromptImageDecisions(params: {
  sessionKey: string;
  message: UserMessage;
  messageIndex: number;
  media: readonly MediaFact[];
  existingImages: ImageContent[];
  load: (media: readonly MediaFact[], existingImages: ImageContent[]) => Promise<ImageResolution>;
}): Promise<ImageResolution> {
  const key = JSON.stringify([
    Reflect.get(params.message, "idempotencyKey") ?? [
      params.message.timestamp ?? params.messageIndex,
      params.media.map((fact) => fact.url ?? fact.path ?? null),
    ],
  ]);
  const decisions = sessions.get(params.sessionKey) ?? new Map<string, ImageDecision>();
  sessions.delete(params.sessionKey);
  sessions.set(params.sessionKey, decisions);
  if (sessions.size > MAX_IMAGE_DECISION_SESSIONS) {
    for (const oldest of sessions.keys()) {
      sessions.delete(oldest);
      break;
    }
  }
  const previous = decisions.get(key);
  const result = await params.load(
    previous
      ? params.media.map((fact, index) =>
          isImageMediaFact(fact)
            ? {
                ...(previous.media.get(index) ?? fact),
                hydrationSuppressed:
                  fact.hydrationSuppressed === true || !previous.hashes.has(index),
              }
            : fact,
        )
      : params.media,
    // Inline blocks can be resized again on every request, so pinned output
    // hashes cannot filter these raw inputs. The comparison below owns replay.
    params.existingImages,
  );
  if (!previous) {
    const hashes = new Map<number | null, Set<string>>();
    result.images.forEach((image, index) => {
      const part = result.imageFactIndexes[index] ?? null;
      const values = hashes.get(part) ?? new Set<string>();
      values.add(imageHash(image));
      hashes.set(part, values);
    });
    const media = new Map(
      params.media.flatMap((fact, index) =>
        isImageMediaFact(fact) && hashes.has(index) ? [[index, fact] as const] : [],
      ),
    );
    decisions.set(key, {
      media,
      hashes,
      includedCount: result.images.length,
      failedMediaCount: result.failedMediaCount,
    });
    return result;
  }
  const images: ImageContent[] = [];
  const imageFactIndexes: (number | null)[] = [];
  result.images.forEach((image, index) => {
    const part = result.imageFactIndexes[index] ?? null;
    if (previous.hashes.get(part)?.has(imageHash(image))) {
      images.push(image);
      imageFactIndexes.push(part);
    }
  });
  // Pinned omissions are already counted; only a previously included image that
  // is now missing or changed is a new failure.
  return {
    images,
    imageFactIndexes,
    failedMediaCount:
      previous.failedMediaCount + Math.max(0, previous.includedCount - images.length),
  };
}
