import { createHash } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const APPROVERS = ["vincent@openclaw.org", "dallin@openclaw.org"];
const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function parseRequest(value, now) {
  if (!value || typeof value.payload !== "string" || Buffer.byteLength(value.payload) > 12000) {
    throw new Error("A compact JSON payload of at most 12000 bytes is required.");
  }
  const payload = JSON.parse(value.payload);
  if (
    !payload ||
    Array.isArray(payload) ||
    JSON.stringify(payload) !== value.payload ||
    !uuid.test(payload.requestId) ||
    typeof payload.action !== "string" ||
    payload.action.length < 1 ||
    payload.action.length > 120 ||
    typeof payload.expiresAt !== "string"
  ) {
    throw new Error("Invalid immutable request.");
  }
  const expiry = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60 * 1000) {
    throw new Error("Request must expire within 24 hours.");
  }
  return {
    requestId: payload.requestId,
    payload: value.payload,
    expiresAt: payload.expiresAt,
    action: payload.action,
    digest: `sha256:${createHash("sha256").update(value.payload).digest("hex")}`,
    state: "pending",
  };
}

const fieldLabels = new Map([
  ["validationSnapshot", "Existing validation"],
  ["publicationScope", "Publication scope"],
  ["candidateSha", "Candidate commit"],
  ["delta", "Change size"],
  ["reference", "Validated reference"],
  ["outstandingChecks", "Outstanding checks"],
  ["evidenceDigest", "Evidence SHA-256"],
]);
const label = (key) =>
  fieldLabels.get(key) ??
  key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/^./u, (c) => c.toUpperCase());

// Presentation only: every payload field remains visible, including unfamiliar fields.
/** @returns {string[]} */
function detailLines(value, prefix = "") {
  if (value !== null && typeof value === "object") {
    if (
      !Array.isArray(value) &&
      typeof value.name === "string" &&
      typeof value.status === "string"
    ) {
      const { name, status, ...rest } = value;
      const remaining = Object.entries(rest).flatMap(([key, item]) =>
        detailLines(item, label(key)),
      );
      return [
        `<b>${escape(name)}</b> · <b>${escape(status.toUpperCase())}</b>`,
        ...(remaining.length ? [remaining.join(" · ")] : []),
      ];
    }
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index + 1), item])
      : Object.entries(value);
    if (entries.length) {
      return entries.flatMap(([key, item]) =>
        detailLines(item, prefix ? `${prefix} · ${label(key)}` : label(key)),
      );
    }
  }
  return [`<b>${escape(prefix)}</b>: ${escape(String(value === null ? "None" : value))}`];
}

// Group safe integers only. Formatting fractions must not round the value being approved.
const displayValue = (value) =>
  Number.isSafeInteger(value) ? value.toLocaleString("en-US") : String(value ?? "None");

function detailWidget(key, value) {
  if (
    value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length &&
    Object.values(value).every((item) => typeof item === "number")
  ) {
    return {
      decoratedText: {
        topLabel: label(key),
        text: Object.entries(value)
          .map(
            ([name, count]) =>
              `${escape(displayValue(count))} ${escape(label(name).toLowerCase())}`,
          )
          .join(" · "),
        wrapText: true,
      },
    };
  }
  if (value !== null && typeof value === "object") {
    return {
      textParagraph: { text: `<b>${escape(label(key))}</b><br>${detailLines(value).join("<br>")}` },
    };
  }
  const text = displayValue(value);
  const decoratedText = { topLabel: label(key), text: escape(text), wrapText: true };
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) {
        decoratedText.onClick = { openLink: { url: value } };
      }
    } catch {
      /* Ordinary review text is not a link. */
    }
  }
  return { decoratedText };
}

export function approvalCard(request, callbackUrl) {
  const payload = JSON.parse(request.payload);
  const metadata = new Set(["schemaVersion", "policy", "requestId", "expiresAt"]);
  const overview = [detailWidget("action", request.action)];
  const details = [];
  const technical = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "action") {
      continue; // Already shown in a full, wrapping field above.
    }
    if (metadata.has(key)) {
      technical.push(detailWidget(key, value));
    } else if (value !== null && typeof value === "object") {
      const entries =
        Array.isArray(value) || key === "delta" ? [[key, value]] : Object.entries(value);
      const priority = (name) => (name === "summary" ? -2 : name === "outstandingChecks" ? -1 : 0);
      entries.sort(([a], [b]) => priority(a) - priority(b));
      const section = {
        header: escape(label(key)),
        widgets: entries.length
          ? entries.map(([name, item]) => detailWidget(name, item))
          : [detailWidget(key, value)],
        ...(key === "delta" || key === "publicationScope"
          ? {}
          : {
              collapsible: true,
              uncollapsibleWidgetsCount: key === "validationSnapshot" ? 2 : 0,
            }),
      };
      if (key === "validationSnapshot") {
        details.unshift(section);
      } else {
        details.push(section);
      }
    } else {
      overview.push(detailWidget(key, value));
    }
  }
  if (request.approverEmail) {
    overview.push(detailWidget("decidedBy", request.approverEmail));
  }
  if (request.decidedAt) {
    overview.push(detailWidget("decidedAt", request.decidedAt));
  }
  technical.push(detailWidget("requestDigest", request.digest));
  const buttons = ["Approve", "Reject"].map((text) => ({
    text,
    onClick: {
      action: {
        function: callbackUrl,
        parameters: [
          { key: "requestId", value: request.requestId },
          { key: "digest", value: request.digest },
          { key: "decision", value: text.toLowerCase() },
        ],
      },
    },
  }));
  return {
    cardsV2: [
      {
        cardId: request.requestId,
        card: {
          header: {
            title:
              request.state === "pending"
                ? "Approval requested"
                : `${request.state.toUpperCase()}: Approval request`,
            subtitle: `Expires ${new Date(request.expiresAt).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`,
          },
          sections: [
            ...(overview.length ? [{ header: "Request", widgets: overview }] : []),
            ...details,
            {
              header: "Request identity and policy",
              collapsible: true,
              uncollapsibleWidgetsCount: 0,
              widgets: technical,
            },
            ...(request.state === "pending" ? [{ widgets: [{ buttonList: { buttons } }] }] : []),
          ],
        },
      },
    ],
  };
}

/** Google authenticates the callback. Only this path can settle a human decision. */
export async function handleChat(event, store, now) {
  const chat = event?.chat;
  const user = chat?.user;
  if (user?.type !== "HUMAN" || !/^users\/[0-9]+$/u.test(user.name ?? "")) {
    throw new Error("A Google Chat human identity is required.");
  }
  if (!APPROVERS.includes(user.email)) {
    throw new Error("This account is not an approver.");
  }
  if (chat.addedToSpacePayload?.space?.spaceType === "DIRECT_MESSAGE") {
    await store.enroll(user.email, user.name, chat.addedToSpacePayload.space.name);
    return { text: "Approval notifications enabled for this account." };
  }
  const values = event.commonEventObject?.parameters;
  if (
    !chat.buttonClickedPayload ||
    !values ||
    Object.keys(values).toSorted().join(",") !== "decision,digest,requestId" ||
    !["approve", "reject"].includes(values.decision) ||
    !uuid.test(values.requestId ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(values.digest ?? "")
  ) {
    throw new Error("Only approval-card buttons can record a decision.");
  }
  const result = await store.decide({
    ...values,
    userId: user.name,
    email: user.email,
    space: chat.buttonClickedPayload.space?.name,
    decision: values.decision === "approve" ? "approved" : "rejected",
    now,
  });
  if (result.lastAttempt.previousState !== "pending") {
    const action = values.decision === "approve" ? "Approve" : "Reject";
    return {
      ...approvalCard(result),
      text: `No change: request ${values.requestId} was already ${result.state}. Your ${action} action did not change the existing decision. A different decision requires a new request.`,
    };
  }
  return { ...approvalCard(result), text: `Request ${values.requestId}: ${result.state}.` };
}

export function settleDecision(request, actor, enrollment) {
  if (
    !request ||
    request.digest !== actor.digest ||
    enrollment?.userId !== actor.userId ||
    enrollment?.space !== actor.space
  ) {
    throw new Error("Request or enrolled approver identity does not match.");
  }
  // A first decision wins. Retries never turn a rejection into an approval.
  if (request.state !== "pending") {
    return request;
  }
  if (Date.parse(request.expiresAt) <= actor.now) {
    throw new Error("Request expired.");
  }
  return {
    ...request,
    state: actor.decision,
    approver: actor.userId,
    approverEmail: actor.email,
    decidedAt: new Date(actor.now).toISOString(),
  };
}
