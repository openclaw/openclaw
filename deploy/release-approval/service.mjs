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

export function approvalCard(request, callbackUrl) {
  const details = JSON.stringify(JSON.parse(request.payload), null, 2);
  const chunks = details.match(/[\s\S]{1,2000}/gu) ?? [];
  return {
    cardsV2: [
      {
        cardId: request.requestId,
        card: {
          header: {
            title:
              request.state === "pending"
                ? request.action
                : `${request.state.toUpperCase()}: ${request.action}`,
            subtitle: `Expires ${request.expiresAt}`,
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: escape(request.digest) } },
                ...chunks.map((text) => ({
                  textParagraph: { text: `<pre>${escape(text)}</pre>` },
                })),
              ],
            },
            ...(request.state === "pending"
              ? [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: ["Approve", "Reject"].map((text) => ({
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
                          })),
                        },
                      },
                    ],
                  },
                ]
              : []),
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
