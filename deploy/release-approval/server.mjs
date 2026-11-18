import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { APPROVERS, approvalCard, handleChat, parseRequest, settleDecision } from "./service.mjs";

export class FirestoreStore {
  constructor(db) {
    this.db = db;
  }
  approver(email) {
    return this.db.collection("approvers").doc(email);
  }
  request(id) {
    return this.db.collection("requests").doc(id);
  }
  async enroll(email, userId, space) {
    if (!/^spaces\/[A-Za-z0-9_-]+$/u.test(space ?? "")) {
      throw new Error("Invalid DM space.");
    }
    await this.db.runTransaction(async (tx) => {
      const ref = this.approver(email);
      const existing = (await tx.get(ref)).data();
      if (existing && existing.userId !== userId) {
        throw new Error("Stable user ID changed. Administrator intervention required.");
      }
      tx.set(ref, { userId, space });
    });
  }
  async create(request) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.request(request.requestId);
      const existing = (await tx.get(ref)).data();
      if (existing && existing.digest !== request.digest) {
        throw new Error("Request ID already binds different contents.");
      }
      if (!existing) {
        tx.create(ref, request);
      }
      return existing ?? request;
    });
  }
  async get(id) {
    return (await this.request(id).get()).data();
  }
  async enrollments() {
    return Promise.all(
      APPROVERS.map(async (email) => {
        const data = (await this.approver(email).get()).data();
        return { email, userId: data?.userId, space: data?.space };
      }),
    );
  }
  async decide(actor) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.request(actor.requestId);
      const request = (await tx.get(ref)).data();
      const enrollment = (await tx.get(this.approver(actor.email))).data();
      const result = settleDecision(request, actor, enrollment);
      // Keep the first decision, but retain bounded evidence of the latest attempted action.
      const recorded = {
        ...result,
        lastAttempt: {
          requestedDecision: actor.decision,
          previousState: request.state,
          outcome: result === request ? "unchanged" : "recorded",
          userId: actor.userId,
          receivedAt: new Date(actor.now).toISOString(),
        },
      };
      tx.set(ref, recorded);
      return recorded;
    });
  }
}

export function googleVerifier() {
  const client = new OAuth2Client();
  return async (authorization, audience, allowedEmails) => {
    if (!authorization?.startsWith("Bearer ")) {
      throw new Error("Missing bearer token.");
    }
    const ticket = await client.verifyIdToken({ idToken: authorization.slice(7), audience });
    const claims = ticket.getPayload();
    if (claims?.email_verified !== true || !allowedEmails.includes(claims.email)) {
      throw new Error("Identity is not authorized for this endpoint.");
    }
  };
}

/** Public HTTPS ingress, but every route authenticates its own distinct principal and audience. */
export function createHandler({
  store,
  verify,
  notify,
  baseUrl,
  chatIdentity,
  requesters,
  readers,
}) {
  return async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const chat = path === "/chat" && req.method === "POST";
      const create = path === "/requests" && req.method === "POST";
      const status = /^\/requests\/([a-f0-9-]{36})$/u.exec(path);
      if (!chat && !create && !(status && req.method === "GET")) {
        res.writeHead(404).end("{}");
        return;
      }
      try {
        await verify(
          req.headers.authorization,
          chat ? `${baseUrl}/chat` : baseUrl,
          chat ? [chatIdentity] : create ? requesters : [...requesters, ...readers],
        );
      } catch {
        res.writeHead(401).end('{"error":"Unauthorized"}');
        return;
      }
      let result;
      if (chat || create) {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 64000) {
            throw new Error("Request too large.");
          }
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (chat) {
          const message = await handleChat(value, store, Date.now());
          const operation = value.chat.buttonClickedPayload
            ? "updateMessageAction"
            : "createMessageAction";
          result = { hostAppDataAction: { chatDataAction: { [operation]: { message } } } };
        } else {
          const request = parseRequest(value, Date.now());
          if (Buffer.byteLength(JSON.stringify(approvalCard(request, `${baseUrl}/chat`))) > 32000) {
            res
              .writeHead(413)
              .end(
                '{"error":"Rendered approval card exceeds Google Chat message limit. Shorten request details."}',
              );
            return;
          }
          const enrollments = (await store.enrollments()).filter(
            (entry) => entry.userId && entry.space,
          );
          if (enrollments.length === 0) {
            res
              .writeHead(409)
              .end(
                '{"error":"No designated approver has enrolled. Add the app in a private Google Chat DM first."}',
              );
            return;
          }
          result = await store.create(request);
          // Deterministic message IDs make retry after partial delivery safe without a queue.
          if (result.state === "pending") {
            const deliveries = await Promise.allSettled(
              enrollments.map((enrollment) => notify(enrollment.space, request)),
            );
            if (deliveries.some((delivery) => delivery.status === "rejected")) {
              throw new Error("Some approval notifications could not be delivered.");
            }
          }
        }
      } else {
        result = await store.get(status[1]);
        if (!result) {
          res.writeHead(404).end("{}");
          return;
        }
      }
      res.end(JSON.stringify(result));
    } catch {
      // Never log payloads, tokens, Google error responses, or user content.
      res
        .writeHead(400)
        .end(
          '{"error":"Request refused or delivery incomplete. Retry the same immutable request."}',
        );
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    SERVICE_URL,
    CHAT_SERVICE_ACCOUNT,
    REQUESTER_EMAILS,
    READER_EMAILS = "",
    PORT = "8080",
  } = process.env;
  if (
    !SERVICE_URL ||
    new URL(SERVICE_URL).protocol !== "https:" ||
    SERVICE_URL.endsWith("/") ||
    !/^service-[0-9]+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/u.test(
      CHAT_SERVICE_ACCOUNT ?? "",
    ) ||
    !REQUESTER_EMAILS
  ) {
    throw new Error("Explicit service URL, Chat principal and requester identities required.");
  }
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/chat.bot"] });
  const handler = createHandler({
    store: new FirestoreStore(new Firestore()),
    verify: googleVerifier(),
    baseUrl: SERVICE_URL,
    chatIdentity: CHAT_SERVICE_ACCOUNT,
    requesters: REQUESTER_EMAILS.split(","),
    readers: READER_EMAILS.split(",").filter(Boolean),
    notify: async (space, request) => {
      const client = await auth.getClient();
      try {
        await client.request({
          method: "POST",
          url: `https://chat.googleapis.com/v1/${space}/messages`,
          params: { messageId: `client-${request.requestId}` },
          data: approvalCard(request, `${SERVICE_URL}/chat`),
        });
      } catch (error) {
        if (error?.response?.status !== 409) {
          throw error;
        }
      }
    },
  });
  createServer((req, res) => {
    void handler(req, res);
  }).listen(Number(PORT), "0.0.0.0");
}
