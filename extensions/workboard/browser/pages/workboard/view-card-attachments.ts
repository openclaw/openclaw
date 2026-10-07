import type { WorkboardAttachment } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderDialog } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import type { WorkboardProps } from "./view-helpers.ts";

type ImageEntry = { status: "loading" } | { status: "ready"; url: string } | { status: "error" };

// Attachment bytes never change for an id, so each connection keeps a small
// object-URL cache and revokes the oldest entries past this bound.
const MAX_CACHED_IMAGES = 40;
const imageCaches = new WeakMap<GatewayBrowserClient, Map<string, ImageEntry>>();
const openPreviews = new WeakMap<object, string>();

export function isImageAttachment(attachment: WorkboardAttachment): boolean {
  return attachment.mimeType?.toLowerCase().startsWith("image/") === true;
}

function imageCache(client: GatewayBrowserClient): Map<string, ImageEntry> {
  let cache = imageCaches.get(client);
  if (!cache) {
    cache = new Map();
    imageCaches.set(client, cache);
  }
  return cache;
}

function storeImage(cache: Map<string, ImageEntry>, id: string, entry: ImageEntry) {
  cache.delete(id);
  cache.set(id, entry);
  for (const [oldId, oldEntry] of cache) {
    if (cache.size <= MAX_CACHED_IMAGES) {
      break;
    }
    if (oldEntry.status === "ready") {
      URL.revokeObjectURL(oldEntry.url);
    }
    cache.delete(oldId);
  }
}

function loadImage(props: WorkboardProps, attachment: WorkboardAttachment): ImageEntry | undefined {
  const client = props.client;
  if (!client) {
    return undefined;
  }
  const cache = imageCache(client);
  const cached = cache.get(attachment.id);
  if (cached) {
    return cached;
  }
  const loading: ImageEntry = { status: "loading" };
  storeImage(cache, attachment.id, loading);
  void client
    .request<{ contentBase64?: unknown }>("workboard.cards.attachments.get", {
      id: attachment.id,
    })
    .then((payload) => {
      if (typeof payload?.contentBase64 !== "string") {
        throw new Error("attachment content is missing.");
      }
      const bytes = Uint8Array.from(atob(payload.contentBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: attachment.mimeType });
      return { status: "ready", url: URL.createObjectURL(blob) } as const;
    })
    .catch(() => ({ status: "error" }) as const)
    .then((entry) => {
      // An evicted request must not resurrect its entry or leak its object URL.
      if (cache.get(attachment.id) !== loading) {
        if (entry.status === "ready") {
          URL.revokeObjectURL(entry.url);
        }
        return;
      }
      storeImage(cache, attachment.id, entry);
      props.onRequestUpdate?.();
    });
  return loading;
}

function renderThumbnail(
  props: WorkboardProps,
  owner: object,
  attachment: WorkboardAttachment,
): unknown {
  const entry = loadImage(props, attachment);
  const label = t("workboard.attachmentOpenImage", { name: attachment.fileName });
  return html`<li>
    <button
      class="workboard-attachment-thumb"
      type="button"
      title=${attachment.note ? `${attachment.fileName} - ${attachment.note}` : attachment.fileName}
      aria-label=${label}
      ?disabled=${entry?.status !== "ready"}
      @click=${() => {
        openPreviews.set(owner, attachment.id);
        props.onRequestUpdate?.();
      }}
    >
      ${
        entry?.status === "ready"
          ? html`<img src=${entry.url} alt="" loading="lazy" decoding="async" />`
          : html`<span class="workboard-attachment-thumb__status">
              ${
                entry?.status === "error"
                  ? t("workboard.attachmentImageUnavailable")
                  : t("workboard.attachmentImageLoading")
              }
            </span>`
      }
    </button>
    <span class="workboard-attachment-thumb__name">${attachment.fileName}</span>
  </li>`;
}

/** Image attachments render as thumbnails; other attachments stay in technical details. */
export function renderImageAttachments(props: WorkboardProps, owner: object, card: WorkboardCard) {
  const images = (card.metadata?.attachments ?? []).filter(isImageAttachment);
  if (images.length === 0) {
    return nothing;
  }
  return html`<section class="workboard-detail__section workboard-detail__images">
    <h3>${t("workboard.detailImages")}</h3>
    <ul class="workboard-attachment-thumbs">
      ${images.map((attachment) => renderThumbnail(props, owner, attachment))}
    </ul>
  </section>`;
}

export function renderImageAttachmentPreview(
  props: WorkboardProps,
  owner: object,
  card: WorkboardCard,
) {
  const id = openPreviews.get(owner);
  const attachment = id
    ? card.metadata?.attachments?.find((entry) => entry.id === id && isImageAttachment(entry))
    : undefined;
  const entry =
    attachment && props.client ? imageCache(props.client).get(attachment.id) : undefined;
  if (!attachment || entry?.status !== "ready") {
    openPreviews.delete(owner);
    return nothing;
  }
  const close = () => {
    openPreviews.delete(owner);
    props.onRequestUpdate?.();
  };
  return renderDialog(
    {
      label: attachment.fileName,
      description: attachment.note,
      style:
        "--openclaw-modal-width: 1100px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.6);",
      onCancel: () => {
        close();
        return true;
      },
    },
    html`<figure class="workboard-image-preview">
      <div class="workboard-modal__header">
        <h2>${attachment.fileName}</h2>
        <button
          class="btn btn--icon workboard-modal__close"
          type="button"
          aria-label=${t("common.close")}
          autofocus
          @click=${close}
        >
          ${icons.x}
        </button>
      </div>
      <img src=${entry.url} alt=${attachment.note ?? attachment.fileName} />
      ${attachment.note ? html`<figcaption>${attachment.note}</figcaption>` : nothing}
    </figure>`,
  );
}
