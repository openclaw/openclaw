/** Host-owned private-connector context. Never install inside an agent workspace. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const sources = new AsyncLocalStorage();

export async function withConnectorSource(getSource, run) {
  const source = { active: true, getSource };
  try {
    return await sources.run(source, run);
  } finally {
    source.active = false;
  }
}

export function getConnectorSource() {
  const source = sources.getStore();
  return source?.active ? source.getSource() : undefined;
}

const normalize = (s) =>
  String(s ?? "")
    .replace(/@s\.whatsapp\.net$/, "")
    .replace(/^\+/, "");

export function withArthaConnectorContext(fetchFn, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const target = env.ARTHA_CONNECTOR_MCP_URL ?? "https://pitch.artha.vc/mcp";
  const keyFile = env.PERSONAL_MCP_OPENCLAW_CONTEXT_KEY_FILE;
  const readKey = dependencies.readKey ?? (() => readFileSync(keyFile, "utf8").trim());
  const source = dependencies.getSource ?? getConnectorSource;
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete("x-artha-connector-context");
    if (
      request.url === target &&
      keyFile &&
      options.auth === "oauth" &&
      options.identity === "per-requester"
    ) {
      const current = source();
      const requester = options.requesterScope;
      const route = /^agent:[^:]+:whatsapp:([^:]+):direct:([^:]+)$/.exec(options.sessionKey ?? "");
      const bearer = headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      // No source means discovery/subagent/operator traffic. Other Artha tools
      // may still work; personal connector broker calls fail closed. A scheduled
      // source is the owner's own job running in this DM; DFS limits it to reads.
      const fromMessage =
        current?.channel === "whatsapp" &&
        current.accountId === route?.[1] &&
        normalize(current.senderId) === normalize(route?.[2]);
      if (
        bearer &&
        route &&
        current?.messageId &&
        current.sessionKey === options.sessionKey &&
        (current.scheduled === true || fromMessage) &&
        requester?.messageChannel === "whatsapp" &&
        requester.agentAccountId === route[1] &&
        normalize(requester.requesterSenderId) === normalize(route[2])
      ) {
        current.assertCurrent();
        let email;
        try {
          // This is not JWT validation. DFS binds this declaration to its own
          // independently validated bearer and canonical caller identity.
          const claims = JSON.parse(
            Buffer.from(bearer.split(".")[1], "base64url").toString("utf8"),
          );
          const identity = claims.email ?? claims.preferred_username;
          if (typeof identity === "string" && identity.includes("@"))
            email = identity.trim().toLowerCase();
        } catch {
          /* Opaque or email-less bearer cannot establish connector identity. */
        }
        if (email) {
          const key = readKey();
          if (Buffer.byteLength(key) < 32) throw new Error("Connector signing key is invalid");
          const epoch = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
          const claims = {
            v: 1,
            aud: "artha-personal-mcp",
            identity_mode: "per-requester",
            session_kind: current.scheduled === true ? "scheduled" : "interactive",
            user_id: email,
            channel: "whatsapp",
            chat_kind: "private",
            conversation_id: options.sessionKey,
            message_id: String(current.messageId),
            request_id: randomUUID(),
            token_sha256: createHash("sha256").update(bearer).digest("hex"),
            iat: epoch,
            exp: epoch + 90,
          };
          const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
          headers.set(
            "x-artha-connector-context",
            `${encoded}.${createHmac("sha256", key).update(encoded).digest("hex")}`,
          );
        }
      }
    }
    return fetchFn(
      new Request(request, {
        headers,
        // The attestation is valid for this exact resource only. A redirect must
        // not forward it or replay the signed request at another resource.
        ...(headers.has("x-artha-connector-context") ? { redirect: "error" } : {}),
      }),
    );
  };
}
