#!/usr/bin/env node

const packageName = process.argv[2];

if (!packageName) {
  console.error("usage: node scripts/npm-oidc-exchange-token.mjs <package-name>");
  process.exit(2);
}

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

if (!requestUrl || !requestToken) {
  console.error(
    "GitHub OIDC request environment is missing. ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are required.",
  );
  process.exit(1);
}

async function readJson(response, context) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${context} failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

const oidcUrl = new URL(requestUrl);
oidcUrl.searchParams.set("audience", "npm:registry.npmjs.org");

const oidcResponse = await fetch(oidcUrl, {
  headers: {
    Authorization: `Bearer ${requestToken}`,
  },
});
const oidcPayload = await readJson(oidcResponse, "GitHub OIDC token request");
const idToken = oidcPayload && typeof oidcPayload.value === "string" ? oidcPayload.value : "";

if (!idToken) {
  throw new Error("GitHub OIDC token response did not include a token value.");
}

const exchangeUrl = new URL(
  `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(packageName)}`,
);

const exchangeResponse = await fetch(exchangeUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${idToken}`,
  },
});
const exchangePayload = await readJson(exchangeResponse, "npm OIDC exchange");
const registryToken =
  exchangePayload && typeof exchangePayload.token === "string" ? exchangePayload.token : "";

if (!registryToken) {
  throw new Error("npm OIDC exchange response did not include a registry token.");
}

process.stdout.write(registryToken);
