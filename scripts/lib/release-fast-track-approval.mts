import { z } from "zod";
import {
  collectFastTrackEligibility,
  fastTrackRequestDigest,
  parseFastTrackRequest,
  serializeFastTrackRequest,
  type FastTrackRequest,
  type ValidatedFastTrackReference,
} from "./release-fast-track-contract.mts";

const approvalStatusSchema = z.object({
  requestId: z.string(),
  digest: z.string(),
  payload: z.string(),
  expiresAt: z.string(),
  state: z.enum(["pending", "approved", "rejected"]),
  approver: z.string().optional(),
  approverEmail: z.string().optional(),
  decidedAt: z.string().optional(),
});

/** Request/read transport only. Neither operation can record a human decision. */
export async function exchangeFastTrackApproval(input: {
  serviceOrigin: string;
  identityToken: string;
  request: FastTrackRequest;
  operation: "request" | "status";
}) {
  const origin = new URL(input.serviceOrigin);
  if (origin.protocol !== "https:" || origin.origin !== input.serviceOrigin) {
    throw new Error(
      "Approval service must be a pinned HTTPS origin without a path or credentials.",
    );
  }
  if (!input.identityToken || !/^[A-Za-z0-9._-]+$/u.test(input.identityToken)) {
    throw new Error("A well-formed request-only or read-only Google identity token is required.");
  }
  const request = parseFastTrackRequest(input.request);
  const payload = serializeFastTrackRequest(request);
  if (Buffer.byteLength(payload) > 12000) {
    throw new Error("Approval request exceeds the service payload limit.");
  }
  if (input.operation === "request" && Date.parse(request.expiresAt) <= Date.now()) {
    throw new Error("Cannot submit an expired approval request. Create a new immutable request.");
  }
  let response: Response;
  try {
    response = await fetch(
      `${origin.origin}/requests${input.operation === "status" ? `/${request.requestId}` : ""}`,
      {
        method: input.operation === "request" ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${input.identityToken}`,
          "Content-Type": "application/json",
        },
        ...(input.operation === "request" ? { body: JSON.stringify({ payload }) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    // Node/HTTP errors can echo header values. Never propagate transport error text.
    throw new Error(
      "Approval service transport failed. Check connectivity and identity-token formatting.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Approval service refused ${input.operation} (HTTP ${response.status}). Retry only the same immutable request after resolving authentication or delivery.`,
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > 64 * 1024) {
    throw new Error("Approval response exceeds size limit.");
  }
  const approval = approvalStatusSchema.parse(JSON.parse(body));
  if (
    approval.requestId !== request.requestId ||
    approval.digest !== fastTrackRequestDigest(request) ||
    approval.payload !== payload ||
    approval.expiresAt !== request.expiresAt
  ) {
    throw new Error("Service returned mismatched Google Chat approval for the immutable request.");
  }
  return approval;
}

/** Live authority is the independently operated approval service, never a GitHub actor or receipt. */
export async function verifyFastTrackApproval(input: {
  serviceOrigin: string;
  identityToken: string;
  request: FastTrackRequest;
  repositoryRoot: string;
  validatedReference: ValidatedFastTrackReference;
}): Promise<{
  validation: "validation skipped by approved fast-track";
  approver: string;
  digest: string;
}> {
  const request = parseFastTrackRequest(input.request);
  collectFastTrackEligibility({ ...input, request });
  const approval = await exchangeFastTrackApproval({ ...input, request, operation: "status" });
  const digest = fastTrackRequestDigest(request);
  const now = Date.now();
  const expiry = Date.parse(request.expiresAt);
  const decisionTime =
    typeof approval.decidedAt === "string" ? Date.parse(approval.decidedAt) : Number.NaN;
  if (
    approval.state !== "approved" ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !Number.isFinite(decisionTime) ||
    decisionTime > now ||
    decisionTime >= expiry ||
    typeof approval.approver !== "string" ||
    !/^users\/[0-9]+$/u.test(approval.approver) ||
    !["vincent@openclaw.org", "dallin@openclaw.org"].includes(String(approval.approverEmail))
  ) {
    throw new Error("Missing, rejected, expired, or mismatched Google Chat approval.");
  }
  return {
    validation: "validation skipped by approved fast-track",
    approver: approval.approver,
    digest,
  };
}
