import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

type Peer = ReturnType<typeof createGatewayWsClient>;
type Request = (
  peer: Peer,
  method: "sessions.list",
  params: SessionsListParams,
  window: string,
) => Promise<unknown>;
type Query = "initial" | "search" | "page" | "involvement";

export function sessionRowChurnListParams(index: number, query: Query): SessionsListParams {
  return {
    agentId: "main",
    limit: 200,
    rowMode: "sidebar",
    source: query === "search" ? "agent-roster" : "sidebar",
    ...(query === "initial"
      ? {}
      : query === "search"
        ? { search: "team-shape" }
        : query === "page"
          ? { offset: (index % 3) * 200 }
          : {
              profileRelation: { profileId: "team-shape-profile-0", relationship: "involving" },
              ownerFirst: true,
            }),
    configuredAgentsOnly: true,
    excludeDock: true,
    includeGlobal: true,
    includeUnknown: true,
    includeDerivedTitles: true,
    includeLastMessage: true,
  };
}

export async function runSessionRowChurnListRound(
  peers: Iterable<Peer>,
  request: Request,
  label: string,
  round: number,
  mixed: boolean,
) {
  const queries: Query[] = ["search", "page", "involvement"];
  await Promise.all(
    [...peers].map((peer, index) => {
      const query = mixed ? queries[(index + round) % queries.length]! : "search";
      return request(
        peer,
        "sessions.list",
        sessionRowChurnListParams(index, query),
        `${label}:${query}-${round + 1}`,
      );
    }),
  );
}

export async function runSteadySessionRowListPages(
  peers: Iterable<Peer>,
  request: Request,
  label: string,
) {
  for (let repeat = 0; repeat < 3; repeat++) {
    await Promise.all(
      [...peers].map((peer, index) =>
        request(
          peer,
          "sessions.list",
          sessionRowChurnListParams(index, "page"),
          `${label}:steady-${repeat + 1}`,
        ),
      ),
    );
  }
}
