import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

it.each([
  "src/agents/agent-bundle-mcp-requester-connect.ts",
  "src/agents/mcp-auth-profile.ts",
  "src/agents/mcp-config-mutation.ts",
])("keeps %s independent of OAuth runtime and storage", (source) => {
  expect(
    findSourceImportBackedges(source, [
      "src/agents/mcp-oauth.ts",
      "src/agents/mcp-oauth-identity.ts",
      "src/agents/mcp-oauth-store.ts",
    ]),
  ).toEqual([]);
});
