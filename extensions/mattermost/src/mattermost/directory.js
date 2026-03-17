import { listMattermostAccountIds, resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostMe
} from "./client.js";
function buildClient(params) {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled || !account.botToken || !account.baseUrl) {
    return null;
  }
  return createMattermostClient({ baseUrl: account.baseUrl, botToken: account.botToken });
}
function buildClients(params) {
  const accountIds = listMattermostAccountIds(params.cfg);
  const seen = /* @__PURE__ */ new Set();
  const clients = [];
  for (const id of accountIds) {
    const client = buildClient({ cfg: params.cfg, accountId: id });
    if (client && !seen.has(client.token)) {
      seen.add(client.token);
      clients.push(client);
    }
  }
  return clients;
}
async function listMattermostDirectoryGroups(params) {
  const clients = buildClients(params);
  if (!clients.length) {
    return [];
  }
  const q = params.query?.trim().toLowerCase() || "";
  const seenIds = /* @__PURE__ */ new Set();
  const entries = [];
  for (const client of clients) {
    try {
      const me = await fetchMattermostMe(client);
      const channels = await client.request(
        `/users/${me.id}/channels?per_page=200`
      );
      for (const ch of channels) {
        if (ch.type !== "O" && ch.type !== "P") continue;
        if (seenIds.has(ch.id)) continue;
        if (q) {
          const name = (ch.name ?? "").toLowerCase();
          const display = (ch.display_name ?? "").toLowerCase();
          if (!name.includes(q) && !display.includes(q)) continue;
        }
        seenIds.add(ch.id);
        entries.push({
          kind: "group",
          id: `channel:${ch.id}`,
          name: ch.name ?? void 0,
          handle: ch.display_name ?? void 0
        });
      }
    } catch (err) {
      console.debug?.(
        "[mattermost-directory] listGroups: skipping account:",
        err?.message
      );
      continue;
    }
  }
  return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
}
async function listMattermostDirectoryPeers(params) {
  const clients = buildClients(params);
  if (!clients.length) {
    return [];
  }
  const client = clients[0];
  try {
    const me = await fetchMattermostMe(client);
    const teams = await client.request("/users/me/teams");
    if (!teams.length) {
      return [];
    }
    const teamId = teams[0].id;
    const q = params.query?.trim().toLowerCase() || "";
    let users;
    if (q) {
      users = await client.request("/users/search", {
        method: "POST",
        body: JSON.stringify({ term: q, team_id: teamId })
      });
    } else {
      const members = await client.request(
        `/teams/${teamId}/members?per_page=200`
      );
      const userIds = members.map((m) => m.user_id).filter((id) => id !== me.id);
      if (!userIds.length) {
        return [];
      }
      users = await client.request("/users/ids", {
        method: "POST",
        body: JSON.stringify(userIds)
      });
    }
    const entries = users.filter((u) => u.id !== me.id).map((u) => ({
      kind: "user",
      id: `user:${u.id}`,
      name: u.username ?? void 0,
      handle: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.nickname || void 0
    }));
    return params.limit && params.limit > 0 ? entries.slice(0, params.limit) : entries;
  } catch (err) {
    console.debug?.("[mattermost-directory] listPeers failed:", err?.message);
    return [];
  }
}
export {
  listMattermostDirectoryGroups,
  listMattermostDirectoryPeers
};
