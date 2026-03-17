import { UrbitHttpError } from "./errors.js";
import { urbitFetch } from "./fetch.js";
async function putUrbitChannel(deps, params) {
  return await urbitFetch({
    baseUrl: deps.baseUrl,
    path: `/~/channel/${deps.channelId}`,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: deps.cookie
      },
      body: JSON.stringify(params.body)
    },
    ssrfPolicy: deps.ssrfPolicy,
    lookupFn: deps.lookupFn,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 3e4,
    auditContext: params.auditContext
  });
}
async function pokeUrbitChannel(deps, params) {
  const pokeId = Date.now();
  const pokeData = {
    id: pokeId,
    action: "poke",
    ship: deps.ship,
    app: params.app,
    mark: params.mark,
    json: params.json
  };
  const { response, release } = await putUrbitChannel(deps, {
    body: [pokeData],
    auditContext: params.auditContext
  });
  try {
    if (!response.ok && response.status !== 204) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Poke failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`);
    }
    return pokeId;
  } finally {
    await release();
  }
}
async function scryUrbitPath(deps, params) {
  const scryPath = `/~/scry${params.path}`;
  const { response, release } = await urbitFetch({
    baseUrl: deps.baseUrl,
    path: scryPath,
    init: {
      method: "GET",
      headers: { Cookie: deps.cookie }
    },
    ssrfPolicy: deps.ssrfPolicy,
    lookupFn: deps.lookupFn,
    fetchImpl: deps.fetchImpl,
    timeoutMs: 3e4,
    auditContext: params.auditContext
  });
  try {
    if (!response.ok) {
      throw new Error(`Scry failed: ${response.status} for path ${params.path}`);
    }
    return await response.json();
  } finally {
    await release();
  }
}
async function createUrbitChannel(deps, params) {
  const { response, release } = await putUrbitChannel(deps, params);
  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel creation", status: response.status });
    }
  } finally {
    await release();
  }
}
async function wakeUrbitChannel(deps) {
  const { response, release } = await putUrbitChannel(deps, {
    body: [
      {
        id: Date.now(),
        action: "poke",
        ship: deps.ship,
        app: "hood",
        mark: "helm-hi",
        json: "Opening API channel"
      }
    ],
    auditContext: "tlon-urbit-channel-wake"
  });
  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel activation", status: response.status });
    }
  } finally {
    await release();
  }
}
async function ensureUrbitChannelOpen(deps, params) {
  await createUrbitChannel(deps, {
    body: params.createBody,
    auditContext: params.createAuditContext
  });
  await wakeUrbitChannel(deps);
}
export {
  createUrbitChannel,
  ensureUrbitChannelOpen,
  pokeUrbitChannel,
  scryUrbitPath,
  wakeUrbitChannel
};
