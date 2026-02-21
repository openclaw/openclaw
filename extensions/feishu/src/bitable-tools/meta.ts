import { runBitableApiCall, type BitableClient } from "./common.js";

// Accept both native bitable URLs and wiki-embedded bitable URLs.
function parseBitableUrl(url: string): { token: string; tableId?: string; isWiki: boolean } | null {
  try {
    const u = new URL(url);
    const tableId = u.searchParams.get("table") ?? undefined;

    const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) {
      return { token: wikiMatch[1], tableId, isWiki: true };
    }

    const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
    if (baseMatch) {
      return { token: baseMatch[1], tableId, isWiki: false };
    }

    return null;
  } catch {
    return null;
  }
}

async function getAppTokenFromWiki(client: BitableClient, nodeToken: string): Promise<string> {
  // Wiki links expose a wiki node token; bitable APIs require app_token.
  const res = await runBitableApiCall("wiki.space.getNode", () =>
    client.wiki.space.getNode({
      params: { token: nodeToken },
    }),
  );

  const node = res.data?.node;
  if (!node) throw new Error("Node not found");
  if (node.obj_type !== "bitable") {
    throw new Error(`Node is not a bitable (type: ${node.obj_type})`);
  }

  return node.obj_token!;
}

export async function getBitableMeta(client: BitableClient, url: string) {
  const parsed = parseBitableUrl(url);
  if (!parsed) {
    throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
  }

  const appToken = parsed.isWiki ? await getAppTokenFromWiki(client, parsed.token) : parsed.token;

  const res = await runBitableApiCall("bitable.app.get", () =>
    client.bitable.app.get({
      path: { app_token: appToken },
    }),
  );

  let tables: { table_id: string; name: string }[] = [];
  if (!parsed.tableId) {
    // If table is not specified in URL, return available tables to guide the next call.
    const tablesRes = await runBitableApiCall("bitable.appTable.list", () =>
      client.bitable.appTable.list({
        path: { app_token: appToken },
      }),
    );
    tables = (tablesRes.data?.items ?? []).map((t) => ({
      table_id: t.table_id!,
      name: t.name!,
    }));
  }

  return {
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable tools`
      : `Use app_token="${appToken}" for other bitable tools. Select a table_id from the tables list.`,
  };
}
