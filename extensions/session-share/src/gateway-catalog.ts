import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GatewayClient, loadGatewayReaderIdentityV1 } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { coerceSecretRef, resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import {
  sessionCatalogPaging,
  type SessionCatalogProvider,
  type SessionCatalogSession,
  type SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseSessionSharePage, parseSessionShareTranscriptPage } from "./wire.js";

type Identity = NonNullable<NonNullable<SessionCatalogSession["createdActor"]>["identity"]>;
function namespace(identity: Identity, hostId: string): Identity {
  return {
    type: "remote",
    pluginId: "session-share",
    domain: hostId,
    idKind: "source",
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

class SourceConfigurationChangedError extends Error {
  constructor() {
    super("Session Share source configuration changed; restart the service.");
  }
}

type Source = {
  hostId: string;
  label: string;
  client: GatewayClient;
  connected: boolean;
  supportsProfileRelation: boolean;
  // Socket turnover only; this never compares or pins a session/transcript identity.
  connectionVersion: number;
  assertConfigured: () => void;
};

/** Pull-only peers reuse the same catalog console and its polling contract. */
export function createSessionShareGatewayCatalog(api: OpenClawPluginApi): SessionCatalogProvider {
  const sources = new Map<string, Source>();
  // Only this source and its credential providers own the connection lifetime.
  // Unrelated runtime snapshots (for example a cron edit) do not retire it.
  const sourceConfig = (id: string, config = api.runtime.config.current()) => {
    const entry = config.plugins?.entries?.["session-share"];
    const gateways =
      isRecord(entry?.config) && isRecord(entry.config.gateways) ? entry.config.gateways : {};
    const source = gateways[id];
    const access =
      isRecord(source) && isRecord(source.cloudflareAccess) ? source.cloudflareAccess : {};
    const refs = [
      isRecord(source) ? source.deviceToken : undefined,
      access.clientId,
      access.clientSecret,
    ];
    return {
      enabled: config.plugins?.enabled,
      pluginEnabled: entry?.enabled,
      source,
      providers: refs.map((input) => {
        const ref = coerceSecretRef(input);
        return ref ? config.secrets?.providers?.[ref.provider] : undefined;
      }),
    };
  };
  const assertCurrent = (source: Source, connectionVersion: number) => {
    if (
      !source.connected ||
      source.connectionVersion !== connectionVersion ||
      sources.get(source.hostId) !== source
    ) {
      throw new Error("Shared Gateway is unavailable. Refresh the catalog.");
    }
  };
  const stop = async () => {
    const clients = [...sources.values()];
    sources.clear();
    await Promise.all(clients.map((source) => source.client.stopAndWait()));
  };
  api.registerService({
    id: "session-share-gateways",
    apiVersion: 2,
    async start(context) {
      const config = api.runtime.config.current({ clone: true });
      const entry = config.plugins?.entries?.["session-share"]?.config;
      const gateways = isRecord(entry) && isRecord(entry.gateways) ? entry.gateways : {};
      try {
        for (const [id, value] of Object.entries(gateways)) {
          if (!isRecord(value)) {
            continue;
          }
          const binding = structuredClone(sourceConfig(id, config));
          let retired = false;
          const assertConfigured = () => {
            context.scheduler.signal.throwIfAborted();
            retired ||= !isDeepStrictEqual(sourceConfig(id), binding);
            if (retired) {
              throw new SourceConfigurationChangedError();
            }
          };
          const url = new URL(String(value.url));
          if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
            throw new Error(
              "Session Share Gateway URLs must use WSS without embedded credentials.",
            );
          }
          const credential = async (input: unknown) => {
            const ref = coerceSecretRef(input);
            if (!ref) {
              throw new Error("Session Share Gateway credentials require SecretRefs.");
            }
            const resolved = await resolveSecretRefValues([ref], {
              config,
            });
            const token = resolved.values().next().value;
            if (typeof token !== "string" || !token.trim()) {
              throw new Error("Missing Session Share credential.");
            }
            return token;
          };
          if (typeof value.deviceIdentityKey !== "string") {
            throw new Error("A named reader identity is required");
          }
          const deviceIdentity = await loadGatewayReaderIdentityV1(value.deviceIdentityKey);
          const deviceToken = await credential(value.deviceToken);
          let edgeAuthHeaders: Record<string, string> | undefined;
          if (value.cloudflareAccess !== undefined) {
            if (!isRecord(value.cloudflareAccess)) {
              throw new Error("Invalid Access credentials");
            }
            edgeAuthHeaders = {
              "CF-Access-Client-Id": await credential(value.cloudflareAccess.clientId),
              "CF-Access-Client-Secret": await credential(value.cloudflareAccess.clientSecret),
            };
          }
          assertConfigured();
          const hostId = `gateway:${id}`;
          const source: Source = {
            hostId,
            label: typeof value.label === "string" ? value.label : id,
            connected: false,
            supportsProfileRelation: false,
            connectionVersion: 0,
            assertConfigured,
            client: new GatewayClient({
              url: url.href,
              deviceToken,
              deviceIdentity,
              edgeAuthHeaders,
              sharedStateMode: "read-only",
              deviceAuthScope: url.href,
              role: "operator",
              scopes: ["operator.session-share.read"],
              clientDisplayName: "Session Share",
              mode: "backend",
              requestTimeoutMs: 30_000,
              assertConnectionCurrent: () => {
                assertConfigured();
                if (sources.get(hostId) !== source) {
                  throw new Error("Session Share service stopped");
                }
              },
              onHelloOk: (hello) => {
                source.supportsProfileRelation = [
                  "session-share.catalog.list",
                  "session-share.catalog.read",
                ].every((method) => hello?.features?.methods?.includes(method));
                source.connected = true;
                source.connectionVersion++;
              },
              onClose: () => {
                source.connected = false;
                source.connectionVersion++;
              },
            }),
          };
          sources.set(hostId, source);
          source.client.start();
        }
      } catch (error) {
        await stop();
        if (error instanceof SourceConfigurationChangedError) {
          throw error;
        }
        throw new Error(
          "Cannot start Session Share Gateway sources. Check their WSS URLs and SecretRefs.",
          { cause: error },
        );
      }
    },
    stop,
  });
  return {
    id: "openclaw",
    label: "OpenClaw sessions",
    audience: "session-viewers",
    supportsProcessHomeIsolation: true,
    requiresFreshList: true,
    supportsProfileRelation: true,
    async list(query) {
      return Promise.all(
        [...sources.values()]
          .filter((source) => !query.hostIds || query.hostIds.includes(source.hostId))
          .map(async (source) => {
            const common = {
              hostId: source.hostId,
              label: source.label,
              kind: "gateway" as const,
              connected: source.connected,
            };
            try {
              query.signal?.throwIfAborted();
              const connectionVersion = source.connectionVersion;
              source.assertConfigured();
              assertCurrent(source, connectionVersion);
              let relation = source.supportsProfileRelation ? query.profileRelation : undefined;
              let partial = Boolean(query.profileRelation && !relation);
              let cursor = query.cursors?.[source.hostId];
              if (cursor && query.profileRelation) {
                const decoded = sessionCatalogPaging.decodeScopedCursor(
                  cursor,
                  query.profileRelation,
                );
                if (decoded?.startsWith("partial:")) {
                  relation = undefined;
                  partial = true;
                  cursor = decoded.slice("partial:".length);
                } else if (decoded?.startsWith("filtered:") && relation) {
                  cursor = decoded.slice("filtered:".length);
                } else {
                  throw new Error("Invalid relationship page cursor. Refresh the catalog.");
                }
              }
              const requestPage = () =>
                source.client.request(
                  source.supportsProfileRelation
                    ? "session-share.catalog.list"
                    : "session-share.list",
                  {
                    ...(relation ? { profileRelation: relation } : {}),
                    limit: sessionCatalogPaging.boundedLimit(query.limitPerHost),
                    ...(query.search ? { searchTerm: query.search } : {}),
                    ...(cursor ? { cursor } : {}),
                  },
                );
              let page = parseSessionSharePage(await requestPage(), false, relation);
              if (page.relationUnresolved) {
                // Unknown or ambiguous target on the source: show authorized rows unfiltered.
                relation = undefined;
                partial = true;
                cursor = undefined;
                page = parseSessionSharePage(await requestPage(), false, relation);
              }
              assertCurrent(source, connectionVersion);
              query.signal?.throwIfAborted();
              return Object.assign(common, page, {
                ...(page.nextCursor && query.profileRelation
                  ? {
                      nextCursor: sessionCatalogPaging.encodeScopedCursor(
                        `${relation ? "filtered:" : "partial:"}${page.nextCursor}`,
                        query.profileRelation,
                      ),
                    }
                  : {}),
                ...(relation ? { profileRelation: relation } : {}),
                ...(partial
                  ? {
                      error: {
                        code: "FILTER_PARTIAL",
                        message:
                          "Relationship filtering is unavailable on this Gateway source. Showing authorized rows with client-side matching; update the source or check the identity link on both Gateways.",
                      },
                    }
                  : {}),
                sessions: page.sessions.map((session) =>
                  session.createdActor?.identity
                    ? Object.assign({}, session, {
                        createdActor: {
                          ...session.createdActor,
                          identity: namespace(session.createdActor.identity, source.hostId),
                        },
                      })
                    : session,
                ),
              });
            } catch (error) {
              query.signal?.throwIfAborted();
              return Object.assign(common, {
                sessions: [],
                error: {
                  code: "SOURCE_UNAVAILABLE",
                  message:
                    error instanceof SourceConfigurationChangedError
                      ? error.message
                      : "Shared Gateway unavailable. Refresh the catalog.",
                },
              });
            }
          }),
      );
    },
    async read(request) {
      const source = sources.get(request.hostId);
      if (!source) {
        throw new Error("Shared Gateway is unavailable. Refresh the catalog.");
      }
      const connectionVersion = source.connectionVersion;
      source.assertConfigured();
      assertCurrent(source, connectionVersion);
      if (request.profileRelation && !source.supportsProfileRelation) {
        throw new Error(
          "This Gateway does not support relationship filters. Update the source or choose All owners.",
        );
      }
      try {
        const raw = await source.client.request(
          source.supportsProfileRelation ? "session-share.catalog.read" : "session-share.read",
          {
            ...(request.profileRelation ? { profileRelation: request.profileRelation } : {}),
            threadId: request.threadId,
            limit: sessionCatalogPaging.boundedLimit(request.limit),
            ...(request.cursor ? { cursor: request.cursor } : {}),
          },
        );
        const page = parseSessionShareTranscriptPage(raw, request.threadId);
        assertCurrent(source, connectionVersion);
        return {
          ...page,
          hostId: source.hostId,
          label: source.label,
          items: page.items.map((item): SessionCatalogTranscriptItem =>
            item.sender
              ? Object.assign({}, item, {
                  sender: {
                    ...item.sender,
                    identity: namespace(item.sender.identity, source.hostId),
                  },
                })
              : item,
          ),
        };
      } catch (error) {
        throw error instanceof SourceConfigurationChangedError
          ? error
          : new Error(
              request.profileRelation
                ? "Cannot apply this relationship filter. Check the verified identity link on both Gateways, or choose All owners."
                : "Shared Gateway read failed. Refresh the catalog.",
            );
      }
    },
  };
}
